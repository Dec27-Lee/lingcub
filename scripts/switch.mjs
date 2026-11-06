#!/usr/bin/env node
/**
 * 一键切换 / 回滚（默认只打印计划，不执行）。
 *
 *   node scripts/switch.mjs            # 预演：列出要做的每一步与当前阻拦项
 *   node scripts/switch.mjs --apply    # 真做：停旧消费者 → 装钩子 → 改档位 → 起 lingcub
 *   node scripts/switch.mjs --rollback # 回滚：停 lingcub → 还原钩子备份
 *
 * 它不猜旧桥接怎么启动：回滚只负责「停掉我们起的、还原被我们改的」，
 * 旧服务怎么拉起来由负责人决定（脚本会打印出来）。
 */

import { planSwitch, readLockPid, rollbackChecklist } from './switch-lib.mjs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const apply = process.argv.includes('--apply')
const rollback = process.argv.includes('--rollback')
/**
 * 第二道闸：只加 --apply 还不够，必须显式确认。
 * 起因：一次变异测试把 `--apply` 判成恒真，脚本真的去停生产消费者了。
 * 现在即使参数被误判，没有这个环境变量也一行都不动。
 */
const CONFIRM = process.env.LINGCUB_SWITCH_CONFIRM === '1'
const out = (s) => process.stdout.write(s + '\n')
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function findRoot(start) {
  let dir = start
  for (;;) {
    const pkg = resolve(dir, 'package.json')
    if (existsSync(pkg) && readFileSync(pkg, 'utf8').includes('"@yue/lingcub"')) return dir
    const up = resolve(dir, '..')
    if (up === dir) throw new Error('找不到项目根')
    dir = up
  }
}

const root = findRoot(process.cwd())
const settingsFile = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json')
const lockFile = join(root, 'data/lingcub.lock')

function consumers() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'event consume' } | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)\" }"],
    { encoding: 'utf8', windowsHide: true })
    return (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
      const [pid, parent, cmd] = line.split('|')
      return { pid: Number(pid), parent: Number(parent), cmd: cmd ?? '' }
    })
  } catch {
    return []
  }
}


/**
 * 旧桥接的看门狗（Windows 是 watch-bridge.vbs）。
 * 只停消费进程是不够的：看门狗会在几秒内把旧桥接重新拉起来，两边抢同一个订阅。
 */
function watchdogs() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'watch-bridge|watch_bridge' } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"],
    { encoding: 'utf8', windowsHide: true })
    return (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
      const [pid, cmd] = [line.slice(0, line.indexOf('|')), line.slice(line.indexOf('|') + 1)]
      return { pid: Number(pid), cmd }
    })
  } catch {
    return []
  }
}

/** 快照里记下的「旧看门狗启动命令」：回滚时照它把旧桥接拉回来。 */
function watchdogRestartHint() {
  const f = join(root, 'data/switch-snapshot/old-watchdog.txt')
  if (!existsSync(f)) return null
  const cmd = readFileSync(f, 'utf8').trim()
  return cmd || null
}

function lingcubPid() {
  return readLockPid(lockFile)
}

function writeOverlay() {
  const file = join(root, 'data/local.json')
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const next = { ...cur, mode: 'auto', sessions: { ...(cur.sessions ?? {}), newTopicPolicy: 'open' } }
  mkdirSync(join(root, 'data'), { recursive: true })
  if (apply) writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

function latestHooksBackup() {
  const dir = resolve(settingsFile, '..')
  const base = settingsFile.split(/[\\/]/).pop()
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-lingcub-`))
      .sort()
    return files.length ? join(dir, files.at(-1)) : null
  } catch {
    return null
  }
}

if (rollback) {
  const pid = lingcubPid()
  out(`回滚计划：`)
  out(`1) 停掉 lingcub 常驻${pid ? `（pid ${pid}）` : '（没有在跑）'}`)
  const backup = latestHooksBackup()
  out(`2) 还原 claude 钩子${backup ? `：${backup}` : '（没有找到备份，跳过）'}`)
  out('3) 回滚后按这三条核对：')
  for (const line of rollbackChecklist({ lingcubPid: pid, consumers: consumers() })) out(`   ${line}`)
  if (!apply || !CONFIRM) {
    out('')
    if (apply && !CONFIRM) out('已给 --apply，但缺少确认变量：设 LINGCUB_SWITCH_CONFIRM=1 才会真执行。')
    out('预演（没做任何事）。')
  } else {
    if (pid) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* 已经没了 */
      }
      try {
        unlinkSync(lockFile)
      } catch {
        /* 已经不在了 */
      }
      out(`已停 lingcub（pid ${pid}）`)
    }
    if (backup) {
      writeFileSync(settingsFile, readFileSync(backup, 'utf8'), 'utf8')
      out(`已还原钩子：${backup}`)
    }
    const hint = watchdogRestartHint()
    out(hint ? `请用它原来的方式拉起旧桥接：\n  ${hint}` : '请手动拉起旧桥接（它的启动方式脚本不猜）。')
  }
} else {
  const pid = lingcubPid()
  const plan = planSwitch({ consumers: consumers(), watchdogs: watchdogs(), lingcubPid: pid })
  const ours = plan.ourConsumers.map((p) => ({ pid: p }))
  const list = plan.theirConsumers.map((p) => ({ pid: p }))
  const dogs = plan.watchdogPids.map((p) => ({ pid: p }))
  out('切换计划：')
  out(`0) 停旧桥接的看门狗：${dogs.length ? dogs.map((c) => c.pid).join('、') : '（没有在跑）'}`)
  out(`1) 停旧的事件消费者：${list.length ? list.map((c) => c.pid).join('、') : '（没有在跑）'}`)
  if (ours.length) out(`   自己的消费进程 ${ours.map((c) => c.pid).join('、')} 不动（lingcub 已经在跑，切换时会连它一起重启）`)
  out('2) 装 claude 钩子（写前自动备份原 settings.json）')
  out(`3) 改本机档位：mode=auto、sessions.newTopicPolicy=open（只写 data/local.json）`)
  out('4) 起 lingcub 常驻（分离进程，日志写 data/lingcub.log）')
  if (pid) out(`\n注意：lingcub 已经在跑（pid ${pid}），要先停它再切。`)

  if (!apply || !CONFIRM) {
    out('')
    if (apply && !CONFIRM) out('已给 --apply，但缺少确认变量：设 LINGCUB_SWITCH_CONFIRM=1 才会真执行。')
    out('预演（没做任何事）。')
    out(`钩子将写入：${settingsFile}`)
  } else {
    // 先停看门狗：否则它会在几秒内把旧桥接重新拉起来，两边抢同一个订阅
    for (const d of dogs) {
      try {
        execFileSync('taskkill', ['/PID', String(d.pid), '/T', '/F'], { stdio: 'ignore' })
        out(`已停旧桥接的看门狗 ${d.pid}`)
      } catch (e) {
        out(`停看门狗 ${d.pid} 失败：${String(e.message).split('\n')[0]}`)
      }
    }
    for (const c of list) {
      // 先礼后兵：dws 自己会退订；lark-cli 停进程即可（订阅随连接释放）
      try {
        execFileSync('taskkill', ['/PID', String(c.pid), '/T'], { stdio: 'ignore' })
        out(`已请求停止消费者 ${c.pid}`)
      } catch (e) {
        out(`停 ${c.pid} 失败：${String(e.message).split('\n')[0]}`)
      }
    }
    const hooks = spawnSync(process.execPath, [join(root, 'dist/main.js'), 'hook', 'install', '--apply'],
      { encoding: 'utf8', cwd: root })
    out((hooks.stdout ?? '') + (hooks.stderr ?? ''))

    const overlay = writeOverlay()
    out(`已写覆盖层：mode=${overlay.mode} newTopicPolicy=${overlay.sessions.newTopicPolicy}`)

    const child = spawn(process.execPath, [join(root, 'dist/main.js'), 'run'], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    out(`已拉起 lingcub run（pid ${child.pid}）`)

    // 等它就绪：锁文件 + 钩子端点
    const deadline = Date.now() + 20_000
    let ready = false
    while (Date.now() < deadline) {
      if (existsSync(lockFile) && existsSync(join(root, 'data/hooks.json'))) {
        ready = true
        break
      }
      sleep(200)
    }
    out(ready ? '就绪：锁与钩子端点都在' : '警告：20 秒内没等到锁/钩子端点，请看 data/lingcub.log')
    out('\n下一步：在飞书里给这个群发一条消息，应当开出一个新窗口（话题里会出现「窗口已创建」和状态卡）。')
  }
}
