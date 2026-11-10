/**
 * 平台自己发起的一次性 claude 调用（摘要、分类）也会注册成 claude 会话。
 *
 * 实测（claude 2.1.319，2026-11-09）：`claude -p` 跑起来后 `claude agents --json` 里就有它，
 * name 是「工作区目录名-两位十六进制」（例如 `lingcub-3b`）、kind=interactive、status=busy，
 * 跟用户手开的终端窗口长得一模一样。不登记就会出现连锁反应：
 * 分析子进程被当成用户窗口接进飞书 → 建话题、置顶 → 跑完把 JSON 分析结果当「窗口回复」推到私聊。
 *
 * 区分办法是我们自己传的 `--session-id`：只有平台发起的一次性调用有它，登记在这个进程内集合里。
 */

import { randomUUID } from 'node:crypto'
import { runOnce, type RunOnceOptions, type RunOnceResult } from './spawn.ts'

const internal = new Set<string>()

/** 一次一次性调用的登记：id + 执行器 + 用途。落库由内核注入的 recorder 做。 */
export interface SpawnRecord {
  sessionId: string
  executor: 'claude' | 'dsh'
  purpose: string
}

let recorder: ((rec: SpawnRecord) => void) | null = null

/**
 * 注入「记一笔」的实现（内核启动时接上 store）。
 *
 * 为什么用注入而不是让插件直接写库：插件契约禁止插件碰库；而这次调用的 id 只有
 * 真正 spawn 的那一层知道——所以由这一层回调出去，谁想记账谁接。
 */
export function setSpawnRecorder(fn: ((rec: SpawnRecord) => void) | null): void {
  recorder = fn
}

export function markInternalClaudeSession(sessionId: string): void {
  if (sessionId) internal.add(sessionId)
}

export function isInternalClaudeSession(sessionId: string): boolean {
  return !!sessionId && internal.has(sessionId)
}

/** binary 是不是 claude（`claude` / `claude.exe` / `C:\…\claude.cmd`）。 */
export function looksLikeClaude(binary: string): boolean {
  return /(^|[\\/])claude(\.exe|\.cmd)?$/i.test(binary.trim())
}

/** 给一次性调用追加 `--session-id`（已有时原样返回），并把 id 记进内部集合。 */
export function internalArgs(args: readonly string[], sessionId: string): string[] {
  if (args.some((a) => a === '--session-id' || a.startsWith('--session-id='))) return [...args]
  markInternalClaudeSession(sessionId)
  return [...args, '--session-id', sessionId]
}

/** 从枚举结果里剔掉平台自己的会话——它们不是用户窗口。 */
export function dropInternalSessions<T extends { sessionId: string }>(list: readonly T[]): T[] {
  return list.filter((s) => !isInternalClaudeSession(s.sessionId))
}

/**
 * 转录里的 `entrypoint=sdk-cli` 表示这是一次性调用（平台自己的摘要/分类子进程），
 * `cli` 才是用户在终端里开的窗口。进程重启后内存登记表会丢，这条判据不丢。
 */
export function isOneShotEntrypoint(entrypoint: string | undefined): boolean {
  return entrypoint === 'sdk-cli'
}

/**
 * 「用户窗口」判定：内存登记 + 转录入口两道闸一起用。
 * 采纳窗口、#resume 列表、关窗回收都走这里，避免各写一遍漏掉一条。
 */
export function keepUserWindows<T extends { sessionId: string; entrypoint?: string }>(list: readonly T[]): T[] {
  return dropInternalSessions(list).filter((s) => !isOneShotEntrypoint(s.entrypoint))
}

/**
 * 从 headless 输出里取执行器会话 id：dsh 首行是 `{"type":"session","sessionId":"session-…"}`。
 * claude 走的是 `--session-id`（id 由我们给），不需要从输出里读。
 */
export function firstSessionId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const j = JSON.parse(t) as { type?: string; sessionId?: string }
      if (j.type === 'session' && typeof j.sessionId === 'string' && j.sessionId) return j.sessionId
    } catch {
      /* 坏行不影响后面的行 */
    }
  }
  return undefined
}

/**
 * 跑一次性 claude 调用，并把它登记为「平台内部会话」：执行器列举活会话时会跳过。
 * 非 claude 二进制（分类器可以配成 dsh）原样跑——`--session-id` 是 claude 的参数。
 */
export async function runClaudeOnce(opts: RunOnceOptions & { purpose?: string }): Promise<RunOnceResult> {
  const purpose = opts.purpose ?? 'internal'
  if (looksLikeClaude(opts.binary)) {
    const sessionId = randomUUID()
    // 先记账再起进程：超时/崩溃时转录可能已经建了，事后补记就找不到是谁的了
    recorder?.({ sessionId, executor: 'claude', purpose })
    return runOnce({ ...opts, args: internalArgs(opts.args, sessionId) })
  }
  const r = await runOnce(opts)
  // dsh 没有 --session-id：会话 id 只能从输出里读，读到了才记
  const sid = firstSessionId(r.stdout)
  if (sid) recorder?.({ sessionId: sid, executor: 'dsh', purpose })
  return r
}
