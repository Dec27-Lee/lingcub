#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { assertAllowedRoot, loadConfigLayered, loadProjects } from './kernel/config.ts'
import { HOOK_SPECS, HOOK_WAIT_SECONDS, groupHasCommand, hookGroup } from './plugin-kit/hook-config.ts'
import { applySync, ccSwitchRunning, hookPlanOf, planSync, readCcSwitch } from './plugin-kit/cc-switch.ts'
import { readHookInfo } from './kernel/hook-server.ts'
import { runRuntime } from './kernel/runtime.ts'
import { discoverPluginsV2 } from './kernel/plugin-v2/index.ts'
import { filterByOwnership } from './kernel/plugin-v2/ownership.ts'
import { installedPlugins } from './kernel/plugin-v2/catalog.ts'
import { switchProblems } from './kernel/plugin-v2/preflight.ts'
import { resolvePluginSections } from './kernel/config-alias.ts'
import { assemble, PLUGIN_DIR } from './kernel/wiring.ts'
import { loadRules } from './routing/rules.ts'
import { openStore } from './kernel/store.ts'
import { scanSpawnTranscripts, totalBytes } from './kernel/spawn-adopt.ts'
import { defaultSpawnDirs, purgeSpawnFiles } from './plugin-kit/internal-session-files.ts'

/**
 * 项目根：从**入口脚本位置**推，不用 cwd。
 *
 * 钩子是 claude 在**窗口自己的 cwd** 里执行的。窗口开在 `E:\Develop_E\tt` 时 `process.cwd()`
 * 就是那个目录 —— 找不到本项目的 `data/hooks.json`，Stop 钩子「静默成功」，一轮结果永远回不来。
 * 2026-11-09 实测：4 个窗口全部走「钩子没到」的兜底，日志里一条「结果已入队」都没有，
 * 而 `data/hook-errors.log` 里留着「端点信息缺失（没有 data/hooks.json）」。
 */
const ROOT = ((): string => {
  // 显式覆盖口：测试与「在别处跑」的部署用它，其余情况按入口脚本位置推
  if (process.env.LINGCUB_ROOT) return resolve(process.env.LINGCUB_ROOT)
  const entry = process.argv[1]
  return entry ? resolve(dirname(entry), '..') : process.cwd()
})()
const cmd = process.argv[2] ?? 'doctor'

function log(level: string, msg: string): void {
  process.stderr.write(`${level.toUpperCase()} ${msg}\n`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

/** claude 的钩子调起我们：把 stdin 的 JSON 转给常驻进程。常驻没跑就静默成功，不打断 claude。 */
/**
 * 代答类钩子（选择题、权限确认）要一直挂着等人作答，所以 HTTP 超时必须跟着钩子本身的
 * timeout 走（settings.json 里写的是 1900 秒）；其余钩子几秒内就该回来。
 * 以前一律 8 秒：人还没看到卡片，HTTP 就被 abort 了，答案永远回不到 claude。
 */
const HOOK_WAIT_MS = (HOOK_WAIT_SECONDS - 10) * 1000

async function hookPost(): Promise<void> {
  const arg = process.argv[4]
  const KINDS = ['stop', 'notify', 'ask', 'permission', 'session-start'] as const
  type HookKind = (typeof KINDS)[number]
  const kind: HookKind = (KINDS as readonly string[]).includes(arg ?? '') ? (arg as HookKind) : 'stop'
  const raw = (await readStdin()).trim() || '{}'
  // 钩子的失败必须在**磁盘上**留痕：claude 会把钩子的 stdout/stderr 吞掉，
  // 只靠 log() 打印等于没有（2026-11-06 就是这样丢了一整轮回复，事后无从查起）。
  const trace = (msg: string): void => {
    try {
      appendFileSync(
        resolve(ROOT, 'data/hook-errors.log'),
        `${new Date().toISOString()} ${kind} ${msg}\n`,
        'utf8',
      )
    } catch {
      /* 写不了就算了，绝不能因此打断 claude */
    }
  }
  const info = readHookInfo(ROOT)
  if (!info) {
    log('WARN', '钩子端点没在跑（没有 data/hooks.json），这条结果先不回了')
    trace('端点信息缺失（没有 data/hooks.json）')
    return
  }
  const url = `http://127.0.0.1:${info.port}/${kind}?t=${info.token}`
  const waitMs = kind === 'ask' || kind === 'permission' ? HOOK_WAIT_MS : 8000
  // 重试一次：端点在重启窗口里会有几百毫秒不可用，一次失败就丢一轮回复太亏
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
        signal: AbortSignal.timeout(waitMs),
      })
      if (!res.ok) {
        trace(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
        log('WARN', `钩子转发失败：${res.status}`)
        return
      }
      if (kind === 'ask' || kind === 'permission' || kind === 'session-start') {
        process.stdout.write(await res.text())
      }
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt === 2) {
        trace(`POST 失败（port=${info.port} pid=${info.pid}）：${msg}`)
        log('WARN', `钩子转发失败：${msg}`)
        return
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  }
}

/** 把 Stop/Notification 钩子写进 claude 配置；默认只预演，加 --apply 才写，且先备份。 */
async function hookInstall(apply: boolean): Promise<void> {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude')
  const file = resolve(claudeDir, 'settings.json')
  const stopCmd = `node "${resolve(ROOT, 'dist/main.js')}" hook post stop`
  const notifyCmd = `node "${resolve(ROOT, 'dist/main.js')}" hook post notify`
  const askCmd = `node "${resolve(ROOT, 'dist/main.js')}" hook post ask`
  const permCmd = `node "${resolve(ROOT, 'dist/main.js')}" hook post permission`
  const startCmd = `node "${resolve(ROOT, 'dist/main.js')}" hook post session-start`

  const rawText = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const hadBom = rawText.charCodeAt(0) === 0xfeff
  const current = rawText ? (JSON.parse(hadBom ? rawText.slice(1) : rawText) as Record<string, unknown>) : {}
  const hooks = (current['hooks'] ?? {}) as Record<string, unknown[]>
  // 装自己的钩子时顺手清掉**旧桥接**留下的钩子：两套并存会让每条消息发两遍，
  // 而且旧桥接的钩子还会抢答选择题/授权。只按路径认，不碰别人的钩子。
  const LEGACY = 'feishu-bridge-claude'
  const withoutLegacy = (list: unknown[]): unknown[] =>
    list
      .map((g) => {
        const group = g as { hooks?: { command?: string }[] }
        const kept = (group.hooks ?? []).filter((h) => !String(h.command ?? '').includes(LEGACY))
        return { ...group, hooks: kept }
      })
      .filter((g) => (g.hooks ?? []).length > 0)

  /** 同一个事件里，同一条命令只留一份（JSON 比较会因转义漏判，必须按命令原串比）。 */
  const dedupe = (list: unknown[]): unknown[] => {
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const g of list) {
      const group = g as { hooks?: Record<string, unknown>[] }
      const kept: Record<string, unknown>[] = []
      for (const h of group.hooks ?? []) {
        const command = String(h.command ?? '')
        if (!command || seen.has(command)) continue
        seen.add(command)
        // 原样保留整条：别家钩子（生产桥接）可能带 timeout / statusMessage，
        // 重建成 `{type,command}` 等于把它们削掉——这里真的削掉过 timeout。
        kept.push(h)
      }
      if (kept.length) out.push({ ...group, hooks: kept })
    }
    return out
  }

  /**
   * 装上本项目的钩子条目（幂等，且能把旧配置升级上来）。
   * 同一个 command 的旧条目先剔掉再按新形状重写——只做「有就跳过」会让旧配置永远缺 timeout。
   */
  const withEntry = (key: string, cmd: string, spec: { matcher?: string; timeout?: number }): unknown[] => {
    const list = dedupe(withoutLegacy(Array.isArray(hooks[key]) ? (hooks[key] as unknown[]) : [])).filter(
      (g) => !groupHasCommand(g, cmd),
    )
    return [...list, hookGroup(cmd, spec)]
  }
  const next = {
    ...current,
    hooks: {
      ...hooks,
      Stop: withEntry('Stop', stopCmd, HOOK_SPECS.stop),
      Notification: withEntry('Notification', notifyCmd, HOOK_SPECS.notify),
      PreToolUse: withEntry('PreToolUse', askCmd, HOOK_SPECS.ask),
      PermissionRequest: withEntry('PermissionRequest', permCmd, HOOK_SPECS.permission),
      SessionStart: withEntry('SessionStart', startCmd, HOOK_SPECS.sessionStart),
    },
  }

  log('INFO', `目标文件：${file}`)
  log('INFO', `将写入 Stop：${stopCmd}`)
  log('INFO', `将写入 Notification：${notifyCmd}`)
  log('INFO', `将写入 PreToolUse（只匹配 AskUserQuestion）：${askCmd}`)
  log('INFO', `将写入 PermissionRequest：${permCmd}`)
  log('INFO', `将写入 SessionStart（注入飞书输入约定）：${startCmd}`)
  if (JSON.stringify(next) === JSON.stringify(current)) {
    log('INFO', '已装过，无需改动')
    // live 文件没变化不代表 cc-switch 那边也对：它可能还是旧形状，或者用户刚装/刚新增了服务商
    syncCcSwitchHooks(apply)
    return
  }
  if (!apply) {
    log('INFO', `已清掉旧桥接（${LEGACY}）留下的钩子；接下来只保留本项目的`)
  log('INFO', '这是预演（没写盘）。确认后加 --apply；会先备份原文件')
    return
  }
  if (existsSync(file)) {
    const backup = `${file}.bak-lingcub-${Date.now()}`
    copyFileSync(file, backup)
    log('INFO', `已备份：${backup}`)
  } else {
    mkdirSync(claudeDir, { recursive: true })
  }
  writeFileSync(file, (hadBom ? '\uFEFF' : '') + JSON.stringify(next, null, 2) + '\n', 'utf8')
  log('INFO', '已写入钩子配置')

  // CC Switch（服务商切换器）会把库里那份配置**整体覆盖** settings.json：
  // 不改它的话，用户切一次服务商，钩子就全没了（飞书那边直接哑掉）。
  syncCcSwitchHooks(apply)
}

/**
 * 把同一份钩子写进 CC Switch（装了才做）。
 *
 * 两条硬约束：
 *   · cc-switch 进程在跑时**不写库**——它有内存态，退出时会把内存写回，覆盖我们刚写的；
 *   · 定位条目用 rowid + app_type='claude'，同一个 UUID 在 claude / claude-desktop 下都有。
 */
/** 钩子命令表 → CC Switch 要写的那份 plan（hook install 与 doctor 共用）。 */
function buildHookPlan(): ReturnType<typeof hookPlanOf> {
  const base = `node "${resolve(ROOT, 'dist/main.js')}" hook post`
  return hookPlanOf({
    stop: `${base} stop`,
    notify: `${base} notify`,
    ask: `${base} ask`,
    permission: `${base} permission`,
    sessionStart: `${base} session-start`,
  })
}

function syncCcSwitchHooks(apply: boolean): void {
  const plan = buildHookPlan()
  const state = readCcSwitch()
  if (!state) return // 没装 cc-switch：不影响
  const running = ccSwitchRunning((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true }))
  const todo = planSync(state, plan, { running })
  if (!todo.common && !todo.providers.length) {
    log('INFO', `CC Switch：${state.providers.length} 个 claude 服务商的配置都已带钩子`)
    return
  }
  log('INFO', `CC Switch：通用配置${todo.common ? '缺钩子' : '已带'}，${todo.providers.length} 个服务商需改`)
  for (const p of todo.providers) log('INFO', `  + ${p.name}（rowid ${p.rowid}）`)
  if (todo.blockedBy === 'running') {
    log('WARN', 'CC Switch 正在运行，不能写它的库（退出时会把内存写回覆盖）。先退出 CC Switch，再跑一遍本命令。')
    return
  }
  if (!apply) {
    log('INFO', 'CC Switch：这是预演（没写库）。加 --apply 一起写入')
    return
  }
  try {
    const r = applySync(state, plan, log)
    if (r.changed) log('INFO', 'CC Switch 已同步（切服务商后钩子不会再丢）')
  } catch (e) {
    log('WARN', `CC Switch 同步失败（不影响本机钩子，但切服务商会丢）：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function cmdHook(): Promise<void> {
  const sub = process.argv[3] ?? ''
  if (sub === 'post') return hookPost()
  if (sub === 'install') return hookInstall(process.argv.includes('--apply'))
  throw new Error(`未知 hook 子命令：${sub || '(空)'}（可用 post / install）`)
}

async function cmdRun(): Promise<void> {
  const tickMs = Number(process.env.LINGCUB_TICK_MS ?? 1000)
  await runRuntime({ root: ROOT, tickMs: Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 1000 })
}

async function cmdUi(): Promise<void> {
  const port = Number(process.env.LINGCUB_UI_PORT ?? 0)
  const idle = Number(process.env.LINGCUB_UI_IDLE_MS ?? 15 * 60_000)
  const { startUi } = await import('./desktop/server.ts')
  const ui = await startUi({
    root: ROOT,
    port: Number.isFinite(port) ? port : 0,
    idleExitMs: Number.isFinite(idle) ? idle : 15 * 60_000,
    open: !process.argv.includes('--no-open'),
  })
  log('INFO', `面板已启动：${ui.url}`)
  const stop = (): void => {
    void ui.close().then(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

async function doctor(): Promise<void> {
  const config = loadConfigLayered(resolve(ROOT, 'config/lingcub.yaml'), resolve(ROOT, 'data/local.json'))
  const projects = loadProjects(resolve(ROOT, 'config/projects.yaml'))

  for (const w of projects.workspaces) {
    const policy = config.executor_policies[w.executor]
    if (!policy) throw new Error(`workspace ${w.id} 的执行器 ${w.executor} 无策略`)
    assertAllowedRoot(w.root, policy.allowRoots)
  }

  const rules = loadRules(resolve(ROOT, 'config/rules.yaml'))

  for (const [name, c] of Object.entries(config.classifiers)) {
    if (!existsSync(resolve(ROOT, c.prompt))) {
      throw new Error(`classifiers.${name} 的提示词文件不存在：${c.prompt}`)
    }
  }

  const { ports, unused, installed } = await assemble(PLUGIN_DIR, config, log)
  const v2 = await discoverPluginsV2(PLUGIN_DIR)
  const owned = filterByOwnership(v2, config.control, resolvePluginSections(config).enabled)
  const catalog = installedPlugins(installed, v2, config)
  const active = catalog.filter((p) => p.enabled)
  const idle = catalog.filter((p) => !p.enabled)

  const enabledSources = Object.entries(config.sources)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k)
  log('INFO', `mode=${config.mode} 并发上限=${config.limits.maxConcurrentSessions}`)
  log('INFO', `工作区 ${projects.workspaces.length} 个：`)
  for (const w of projects.workspaces) {
    log('INFO', `  ${w.id.padEnd(18)} ${w.executor.padEnd(7)} ${w.isolation.padEnd(9)} ${w.root}`)
  }
  log('INFO', `启用来源 ${enabledSources.length} 个：${enabledSources.join(', ') || '(无)'}`)
  log('INFO', `规则 ${rules.rules.length} 条：${rules.rules.map((r) => r.id).join(', ') || '(无)'}`)
  log(
    'INFO',
    `已安装插件 ${catalog.length} 个：启用 ${active.length}（${active.map((p) => p.id).join(', ') || '无'}），停用 ${idle.length}（${idle.map((p) => p.id).join(', ') || '无'}）`,
  )
  log(
    'INFO',
    `端口就绪：源 ${ports.sources.size} / 分类器 ${ports.classifiers.size} / 执行器 ${ports.executors.size} / 频道 ${ports.channels.size}`,
  )
  if (unused.length) log('WARN', `有插件未被 config 引用：${unused.join(', ')}`)
  for (const s of owned.skipped) log('WARN', `插件 ${s.id} 未装配：${s.reason}`)
  for (const p of switchProblems(config, resolvePluginSections(config).enabled)) log('WARN', `切换检查：${p}`)

  // CC Switch 的覆盖问题必须能在自检里看到：装完钩子、用户切一次服务商，功能就静默失效，
  // 光靠「记得跑 hook install」是挡不住的。
  const cc = readCcSwitch()
  if (cc) {
    const todo = planSync(cc, buildHookPlan(), { running: false })
    if (!todo.common && !todo.providers.length) {
      log('INFO', `CC Switch：${cc.providers.length} 个 claude 服务商都已带钩子`)
    } else {
      log(
        'WARN',
        `CC Switch：${todo.common ? '通用配置缺钩子' : '通用配置正常'}，${todo.providers.length} 个服务商需改；` +
          '退出 CC Switch 后跑 `lingcub hook install --apply` 同步（切服务商会用库里的配置整体覆盖 settings.json）',
      )
    }
  }
  // 我们自己发起的一次性调用（分析/分类）每次都在 ~/.claude/projects 下留一个转录，一次 300KB 上下。
  // 报个体量，别等涨到几个 G 才发现——清理按记录的会话 id 删，不靠内容匹配。
  try {
    const dbFile = resolve(ROOT, config.store.path)
    if (existsSync(dbFile)) {
      const s = openStore(dbFile, { readOnly: true })
      try {
        const { total, pending } = s.countSpawns()
        const days = config.cleanup.spawnTtlDays
        const due = s.countSpawnsDue(new Date(Date.now() - days * 86_400_000).toISOString())
        log(
          'INFO',
          `一次性会话：已记录 ${total} 个（未清理 ${pending} 个，其中到期 ${due} 个；保留 ${days} 天）`,
        )
      } finally {
        s.close()
      }
    }
  } catch (e) {
    log('WARN', `一次性会话统计失败（不影响自检）：${e instanceof Error ? e.message : String(e)}`)
  }
  log('INFO', 'doctor 通过')
}

/**
 * 补登记「本轮之前」的一次性会话转录（那之前没有记 id），可选顺手按 id 删掉。
 *
 * ```
 * lingcub spawn scan                 # 只读：算出清单与体量，不写库
 * lingcub spawn adopt --apply        # 写进 spawned_sessions
 * lingcub spawn adopt --apply --purge # 写进去之后立刻按 id 删掉这些文件
 * ```
 *
 * 两道闸：`--apply` + 环境变量 `LINGCUB_SPAWN_CONFIRM=1`。删文件不可逆，不留「一条命令删光」的口子。
 */
async function cmdSpawn(argv: string[]): Promise<void> {
  const action = argv.find((a) => !a.startsWith('-')) ?? 'scan'
  const apply = argv.includes('--apply')
  const purge = argv.includes('--purge')
  if (action !== 'scan' && action !== 'adopt') throw new Error(`未知子命令：${action}（可用：scan | adopt）`)

  const dirs = defaultSpawnDirs()
  const scan = scanSpawnTranscripts(dirs.claudeProjectsDir)
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)
  log('INFO', `目录：${dirs.claudeProjectsDir}`)
  log(
    'INFO',
    `可登记 ${scan.adopt.length} 个 / ${mb(totalBytes(scan.adopt))} MB（sdk-cli + 本平台任务模板）`,
  )
  log(
    'INFO',
    `不动：sdk-cli 但无模板 ${scan.sdkCliUnmarked.length} / 交互式会话 ${scan.interactive.length} / 认不出 ${scan.unknown.length}`,
  )
  for (const c of scan.adopt.slice(0, 5)) log('INFO', `  · ${c.sessionId}  ${(c.bytes / 1024).toFixed(0)}KB`)
  if (scan.adopt.length > 5) log('INFO', `  · …共 ${scan.adopt.length} 个`)

  if (action === 'scan') {
    log('INFO', '以上是预演。要登记跑 `lingcub spawn adopt --apply`（需再设 LINGCUB_SPAWN_CONFIRM=1）')
    return
  }
  if (!apply) {
    log('WARN', '没加 --apply，只预演，没有写库')
    return
  }
  if (process.env.LINGCUB_SPAWN_CONFIRM !== '1') {
    log('ERROR', '缺确认闸：再加环境变量 LINGCUB_SPAWN_CONFIRM=1 才写库（防误跑）')
    process.exitCode = 2
    return
  }
  if (!scan.adopt.length) {
    log('INFO', '没有可登记的')
    return
  }

  const config = loadConfigLayered(resolve(ROOT, 'config/lingcub.yaml'), resolve(ROOT, 'data/local.json'))
  const store = openStore(resolve(ROOT, config.store.path))
  try {
    // 发生时间用文件 mtime，不是「导入时间」：TTL 才按真实时间算，不然这批要再等一整轮 7 天
    for (const c of scan.adopt) {
      store.recordSpawn(c.sessionId, 'claude', 'adopted', new Date(c.mtimeMs).toISOString())
    }
    const dates = scan.adopt.map((c) => new Date(c.mtimeMs).toISOString().slice(0, 10)).sort()
    log('INFO', `已登记 ${scan.adopt.length} 个到 spawned_sessions（原发生时间 ${dates[0]} ~ ${dates[dates.length - 1]}）`)

    if (!purge) {
      log('INFO', `登记完不动文件；之后由每小时清理按 TTL（${config.cleanup.spawnTtlDays} 天）删除`)
      return
    }
    // 这些本来就是 TTL 之外的老数据：--purge 就是立刻按 id 删掉刚登记的这一批
    const r = purgeSpawnFiles(
      scan.adopt.map((c) => ({ sessionId: c.sessionId, executor: 'claude' })),
      dirs,
    )
    for (const sid of [...r.removed, ...r.missing]) store.markSpawnPurged(sid)
    log(
      'INFO',
      `已删除 ${r.removed.length} 个转录（${mb(
        scan.adopt.filter((c) => r.removed.includes(c.sessionId)).reduce((n, c) => n + c.bytes, 0),
      )} MB）；文件本来不在 ${r.missing.length} 个；失败 ${r.failed.length} 个`,
    )
    if (r.failed.length) log('WARN', `失败示例：${r.failed[0]?.sessionId} — ${r.failed[0]?.error}`)
  } finally {
    store.close()
  }
}

if (cmd === 'doctor') {
  await doctor().catch((e: unknown) => {
    log('ERROR', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
} else if (cmd === 'run') {
  await cmdRun().catch((e: unknown) => {
    log('ERROR', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
} else if (cmd === 'ui') {
  await cmdUi().catch((e: unknown) => {
    log('ERROR', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
} else if (cmd === 'hook') {
  await cmdHook().catch((e: unknown) => {
    log('ERROR', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
} else if (cmd === 'spawn') {
  await cmdSpawn(process.argv.slice(3)).catch((e: unknown) => {
    log('ERROR', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
} else {
  log('ERROR', `未知命令：${cmd}（可用：doctor | run | ui | hook | spawn）`)
  process.exitCode = 1
}
