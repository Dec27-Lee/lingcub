/** Windows：cscript + VBS 拉起一个干净的 Claude Code 终端窗口。 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runOnce } from '../../plugin-kit/spawn.ts'
import { findLivePeer } from '../../plugin-kit/claude-pipe.ts'
import { ensureTrusted } from '../../plugin-kit/claude-trust.ts'
import { closeClaudeWindow } from '../../plugin-kit/claude-window.ts'

const VBS = resolve(import.meta.dirname, 'win32', 'launch-claude.vbs')

export interface OpenTerminalOptions {
  sessionId: string
  cwd: string
  resumeSessionId?: string
  sessionsDir: string
  timeoutMs: number
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void
  tempDir?: string
  /** 测试注入：信任预置 */
  trust?: (cwd: string) => boolean
  /** 测试注入：超时后收窗 */
  closeWindow?: (sessionId: string) => Promise<number>
  /** 测试注入：不真的跑 cscript / 不真的等会话表 */
  deps?: {
    platform?: NodeJS.Platform
    run?: typeof runOnce
    exists?: (path: string) => boolean
    findPeer?: typeof findLivePeer
    sleep?: (ms: number) => Promise<void>
  }
}

/** 先确认目录存在；VBS 里 cd 失败会静默开在错误目录，这里提前拦住。 */
function assertCwd(cwd: string): void {
  if (!existsSync(cwd)) throw new Error(`工作区不存在：${cwd}`)
}

export async function openClaudeTerminal(opts: OpenTerminalOptions): Promise<void> {
  const deps = opts.deps ?? {}
  const exists = deps.exists ?? existsSync
  const run = deps.run ?? runOnce
  const findPeer = deps.findPeer ?? findLivePeer
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  if ((deps.platform ?? process.platform) !== 'win32') throw new Error('terminal 模式目前只支持 Windows')
  assertCwd(opts.cwd)
  if (!exists(VBS)) throw new Error(`缺少 Windows 启动脚本：${VBS}`)

  // 第一次在某个目录里开窗口会弹「信任这个目录吗」，没人按键盘就永远等不到 SessionStart。
  // 先把信任标记写进 Claude Code 的配置（只加一个键，写前有备份）。
  const trust = opts.trust ?? ((cwd: string) => ensureTrusted(cwd))
  try {
    if (trust(opts.cwd)) opts.log('info', `已预置工作区信任：${opts.cwd}`)
  } catch (e) {
    opts.log('warn', `信任预置失败（窗口可能停在信任弹窗）：${e instanceof Error ? e.message : String(e)}`)
  }

  const args = ['//nologo', VBS, opts.sessionId, opts.cwd]
  if (opts.resumeSessionId) args.push(opts.resumeSessionId)
  const r = await run({ binary: 'cscript.exe', args, timeoutMs: 20_000 })
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 400)
    throw new Error(`开窗失败（cscript exit=${r.code}）${detail ? `：${detail}` : ''}`)
  }
  const bat = join(opts.tempDir ?? process.env.TEMP ?? '', `cc-launch-${opts.sessionId.slice(0, 8)}.cmd`)
  if (!exists(bat)) throw new Error(`启动脚本没有生成（期望在 ${bat}）`)
  opts.log('info', `终端窗口已拉起：claude ${opts.sessionId.slice(0, 8)} @ ${opts.cwd}`)

  // 等 SessionStart 注册出 messaging socket；没注册就投不进去，不能假装 opened。
  const deadline = Date.now() + opts.timeoutMs
  const acceptAt = Date.now() + Math.min(12_000, opts.timeoutMs / 2)
  let acceptTried = false
  while (Date.now() < deadline) {
    if (findPeer(opts.sessionsDir, opts.sessionId)) return
    // 十几秒还没注册，多半停在「是否信任这个工作区」确认框：替用户在**我们自己开的那个窗口**里选 Yes
    if (!acceptTried && Date.now() >= acceptAt) {
      acceptTried = true
      try {
        await run({
          binary: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            resolve(import.meta.dirname, 'win32', 'accept-trust.ps1'),
            opts.sessionId.slice(0, 8),
          ],
          timeoutMs: 15_000,
        })
        opts.log('info', '窗口迟迟没注册，已在它自己的窗口里点了「信任」确认')
      } catch (e) {
        opts.log('warn', `自动接受信任确认失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await sleep(250)
  }
  // 超时先把窗口收掉：卡在信任确认框的窗口留着只会越攒越多
  const close = opts.closeWindow ?? closeClaudeWindow
  let closed: number | undefined
  try {
    closed = await close(opts.sessionId)
  } catch (e) {
    opts.log('warn', `收窗失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const hint = closed
    ? '窗口多半停在「Is this a project you created…?」确认框；已把它关掉，请重试，或先手动在那个目录开一次 claude 并选 Yes'
    : ''
  throw new Error(
    `窗口已拉起，但 ${opts.timeoutMs}ms 内没有等到 Claude Code 会话注册（${opts.sessionsDir}）${hint ? `——${hint}` : ''}`,
  )
}
