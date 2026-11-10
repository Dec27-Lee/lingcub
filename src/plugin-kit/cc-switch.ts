/**
 * CC Switch（服务商切换器）的钩子同步。
 *
 * 为什么必须有这一步：cc-switch 切服务商时不是「改几个键」，而是用数据库里那份
 * `settings_config`（无 commonConfigEnabled 的条目）**整体覆盖** `~/.claude/settings.json`。
 * 只改 live 文件的话，用户一切服务商，钩子全丢——表现为「换了个模型，飞书那边全哑了」。
 *
 * 本机实测（2026-11-09，`~/.cc-switch/cc-switch.db`）：
 *   · 9 个 `app_type='claude'` 条目，全部 `meta.commonConfigEnabled=true`，
 *     自身只有 env/model，**不带 hooks**；
 *   · hooks 落在通用配置 `settings` 表的 `common_config_claude` 里；
 *   · 所以「改 hooks」= 改通用配置 + 改那些 `commonConfigEnabled=false` 的条目自身。
 *
 * 两条硬约束（踩过的坑，别省）：
 *   1. cc-switch 进程在跑时**不能写库**：它有内存态，退出时会把内存写回，覆盖我们刚写的内容。
 *   2. 定位条目必须用 `rowid` + `app_type='claude'`：同一个 UUID 会同时出现在
 *      `claude` 和 `claude-desktop` 两种 app_type 下，只按 id 更新会误伤。
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Log } from '../domain/ports.ts'
import { HOOK_SPECS, mergeHookEntry, type HookSpec } from './hook-config.ts'

export interface CcSwitchProvider {
  rowid: number
  id: string
  name: string
  /** true = 该条目不带非 env 字段，与通用配置叠加；false = 自身保留完整副本。 */
  commonConfigEnabled: boolean
  settings: Record<string, unknown>
  /** 库里的 JSON 解析不出来：这份配置不能拿去合并写回，只能跳过错或报错。 */
  broken?: boolean
}

export interface CcSwitchState {
  dbFile: string
  /** `settings.common_config_claude` 解析后的对象；没有就空对象 */
  common: Record<string, unknown>
  /** 通用配置的 JSON 坏了（不是「没有」）：写回会把服务商的 env/model 抹掉，所以只报不写。 */
  commonBroken?: boolean
  providers: CcSwitchProvider[]
}

/** 一条要改的钩子：事件名 → 命令 + 形状。 */
export type HookPlan = Record<string, { command: string; spec: HookSpec }>

export function ccSwitchDbPath(home = homedir()): string {
  return join(home, '.cc-switch', 'cc-switch.db')
}

/** 解析库里的一段 JSON；返回 null 表示「有内容但解析不出来」——这和「没有」是两件事，不能都当空对象。 */
function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 只读探查；没装 cc-switch 返回 null（没有这个工具的人不该被它影响）。 */
export function readCcSwitch(dbFile = ccSwitchDbPath()): CcSwitchState | null {
  if (!existsSync(dbFile)) return null
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const common = db.prepare("select value from settings where key = 'common_config_claude'").get() as
      | { value?: string }
      | undefined
    const rows = db
      .prepare("select rowid, id, name, settings_config, meta from providers where app_type = 'claude'")
      .all() as unknown as { rowid: number; id: string; name: string; settings_config?: string; meta?: string }[]
    const commonParsed = parseObject(common?.value)
    return {
      dbFile,
      common: commonParsed ?? {},
      commonBroken: commonParsed === null,
      providers: rows.map((r) => ({
        rowid: Number(r.rowid),
        id: r.id,
        name: r.name,
        commonConfigEnabled: parseObject(r.meta)?.['commonConfigEnabled'] !== false,
        ...(() => {
          const settings = parseObject(r.settings_config)
          return { settings: settings ?? {}, broken: settings === null }
        })(),
      })),
    }
  } finally {
    db.close()
  }
}

export interface CcSwitchPlan {
  /** 通用配置要改（绝大多数情况都是它） */
  common: boolean
  /** 自身要改的条目（只有 commonConfigEnabled=false 的才需要） */
  providers: { rowid: number; name: string }[]
  /** cc-switch 在跑：能算清要改什么，但不能落盘 */
  blockedBy: 'running' | null
}

/** 有没有哪份配置还缺这条钩子（缺了才算要改，已带就不重复写）。 */
export function hasHook(settings: Record<string, unknown>, event: string, command: string): boolean {
  const groups = settings['hooks'] as Record<string, unknown> | undefined
  const list = groups?.[event]
  if (!Array.isArray(list)) return false
  return list.some((g) => {
    const hooks = (g as { hooks?: { command?: string; timeout?: number }[] } | null)?.hooks ?? []
    return hooks.some((h) => h?.command === command && h?.timeout !== undefined)
  })
}

export function planSync(state: CcSwitchState, plan: HookPlan, opts: { running: boolean }): CcSwitchPlan {
  const missingCommon = Object.entries(plan).some(([event, { command }]) => !hasHook(state.common, event, command))
  const providerTodo = state.providers.filter(
    (p) =>
      // commonConfigEnabled=true 的条目自身不存非 env 字段，写进去反而会和通用配置打架
      !p.broken &&
      !p.commonConfigEnabled && Object.entries(plan).some(([event, { command }]) => !hasHook(p.settings, event, command)),
  )
  return {
    common: missingCommon,
    providers: providerTodo.map((p) => ({ rowid: p.rowid, name: p.name })),
    blockedBy: opts.running ? 'running' : null,
  }
}

/** 把 plan 里的钩子合并进一份 settings（纯函数，便于单测）。 */
export function mergeHooksInto(settings: Record<string, unknown>, plan: HookPlan): Record<string, unknown> {
  const hooks = { ...((settings['hooks'] as Record<string, unknown> | undefined) ?? {}) }
  for (const [event, { command, spec }] of Object.entries(plan)) {
    hooks[event] = mergeHookEntry(hooks[event], command, spec)
  }
  return { ...settings, hooks }
}

/** cc-switch 进程在不在跑（Windows 用 tasklist；其它平台当作不在）。 */
export function ccSwitchRunning(run: (cmd: string, args: string[]) => string): boolean {
  if (process.platform !== 'win32') return false
  try {
    return /cc-switch\.exe/i.test(run('tasklist', ['/FI', 'IMAGENAME eq cc-switch.exe']))
  } catch {
    return false
  }
}

export interface SyncResult {
  changed: boolean
  common: boolean
  providers: number
  backup?: string
  skipped?: 'not-installed' | 'running' | 'nothing-to-do'
}

/**
 * 落盘：备份 → 事务写通用配置 + 需要的条目 → 关闭。
 * 调用方负责先确认 cc-switch 没在跑（它在跑就别写，内存态会覆盖回去）。
 */
export function applySync(state: CcSwitchState, plan: HookPlan, log: Log): SyncResult {
  // 通用配置读不出来时，mergeHooksInto 会拿空对象起手，写回去等于把服务商的 env/model 全丢掉。
  // 宁可整步失败让人看一眼，也不做这个「成功」。
  if (state.commonBroken) {
    throw new Error(`CC Switch 通用配置不是合法 JSON，拒绝覆盖（先手工核对 ${state.dbFile}）`)
  }
  const todo = planSync(state, plan, { running: false })
  if (!todo.common && !todo.providers.length) return { changed: false, common: false, providers: 0, skipped: 'nothing-to-do' }

  const backup = `${state.dbFile}.bak-lingcub-${Date.now()}`
  copyFileSync(state.dbFile, backup)

  const db = new DatabaseSync(state.dbFile)
  try {
    db.exec('BEGIN')
    if (todo.common) {
      const next = JSON.stringify(mergeHooksInto(state.common, plan))
      db.prepare("UPDATE settings SET value = ? WHERE key = 'common_config_claude'").run(next)
    }
    const update = db.prepare('UPDATE providers SET settings_config = ? WHERE rowid = ? AND app_type = ?')
    for (const p of todo.providers) {
      const cur = state.providers.find((x) => x.rowid === p.rowid)
      if (!cur) continue
      update.run(JSON.stringify(mergeHooksInto(cur.settings, plan)), p.rowid, 'claude')
    }
    db.exec('COMMIT')
    log('info', `CC Switch 已同步：通用配置${todo.common ? '已更新' : '无需改'}，条目 ${todo.providers.length} 个；备份 ${backup}`)
    return { changed: true, common: todo.common, providers: todo.providers.length, backup }
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败就交给备份 */
    }
    throw e
  } finally {
    db.close()
  }
}

/** 把 main 里的钩子命令表转成 plan。 */
export function hookPlanOf(commands: Record<keyof typeof HOOK_SPECS, string>): HookPlan {
  return {
    Stop: { command: commands.stop, spec: HOOK_SPECS.stop },
    Notification: { command: commands.notify, spec: HOOK_SPECS.notify },
    PreToolUse: { command: commands.ask, spec: HOOK_SPECS.ask },
    PermissionRequest: { command: commands.permission, spec: HOOK_SPECS.permission },
    SessionStart: { command: commands.sessionStart, spec: HOOK_SPECS.sessionStart },
  }
}

/** 读一下现有 live 文件（只用于日志里报「几处不一致」）。 */
export function readJsonFile(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
  } catch {
    return {}
  }
}
