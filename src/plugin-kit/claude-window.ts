/**
 * 关掉我们自己拉起的终端窗口。
 *
 * 为什么必须做：窗口卡在信任确认框 / 用户没理它 的时候，SessionStart 永远不会注册，
 * 我们只能判超时。不收拾的话窗口会一直留着，用户看到的就是「开了一堆终端」。
 *
 * 定位方式：启动脚本叫 `cc-launch-<sessionId 前 8 位>.cmd`，那个 `cmd.exe /k …` 就是窗口的
 * 根进程；claude.exe 是它的孙进程，所以 `taskkill /T` 才能连子孙一起关。
 * 只按这个标记找，不碰用户自己开的窗口。
 */

import { runOnce } from './spawn.ts'

export interface CloseDeps {
  run?: typeof runOnce
  platform?: NodeJS.Platform
}

/** 返回关了几个（0 = 没找到，可能窗口已经自己退了）。 */
export async function closeClaudeWindow(sessionId: string, deps: CloseDeps = {}): Promise<number> {
  if ((deps.platform ?? process.platform) !== 'win32') return 0
  const run = deps.run ?? runOnce
  const tag = sessionId.slice(0, 8)
  const find = await run({
    binary: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*cc-launch-${tag}*' } | ForEach-Object { $_.ProcessId }`,
    ],
    timeoutMs: 15_000,
  })
  const pids = (find.stdout ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
  let closed = 0
  for (const pid of pids) {
    const r = await run({ binary: 'taskkill', args: ['/PID', pid, '/T', '/F'], timeoutMs: 15_000 })
    if (r.code === 0) closed++
  }
  return closed
}
