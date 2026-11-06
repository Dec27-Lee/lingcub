/**
 * dsh 侧的会话发现：DSH 没有 `claude agents --json` 这种列举命令，只能读它的存储。
 *
 * 两处来源（2026-11-06 实测本机结构）：
 *   1. `~/.dsh/storages/session_projcache/sessions/<sessionId>.json`
 *      → `record.identity.cwd`（工作区）、`record.rows.title.val`（标题）、文件 mtime（最近活动）
 *   2. `~/.dsh/sessions/<slug>/<sessionId>/session.v*.jsonl.zstd`
 *      → 会话文件 mtime：只能据此猜「还在跑」（没有任何 pid/status/lock 可读）
 *
 * 因此 dsh 的「在跑」是**采样推断**，不是事实：卡上必须写明「仅后台会话 / 状态为推断」。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { underRoots } from './claude-discover.ts'

export interface DshSession {
  sessionId: string
  cwd: string
  title: string
  lastActive: number
  userTurns: number
  /** 推断值：会话文件在 liveWindowMs 内更新过 */
  running: boolean
  /** 推断值：只有 running 时才敢说 busy */
  status?: 'busy' | 'idle'
}

export interface DshDiscoverOptions {
  roots: readonly string[]
  cacheDir?: string
  sessionsDir?: string
  maxAgeDays?: number
  /** 多久内更新过算「在跑」，默认 90 秒 */
  liveWindowMs?: number
  nowMs?: number
  /** 最多返回几条（按最近活动排序） */
  max?: number
}

const defaultCacheDir = (): string => join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
const defaultSessionsDir = (): string => join(homedir(), '.dsh', 'sessions')

/** `~/.dsh/sessions/<slug>/<id>/session.v*.jsonl.zstd` 里最“新”的那个文件的 mtime。 */
export function sessionFileMtime(sessionsDir: string, sessionId: string): number | undefined {
  let slugs: string[]
  try {
    slugs = readdirSync(sessionsDir)
  } catch {
    return undefined
  }
  for (const slug of slugs) {
    const dir = join(sessionsDir, slug, sessionId)
    if (!existsSync(dir)) continue
    let newest: number | undefined
    try {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith('session.v')) continue
        const t = statSync(join(dir, f)).mtimeMs
        if (newest === undefined || t > newest) newest = t
      }
    } catch {
      continue
    }
    if (newest !== undefined) return newest
  }
  return undefined
}

function readCache(file: string): { cwd?: string; title?: string } {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as {
      record?: { identity?: { cwd?: unknown }; rows?: { title?: { val?: unknown } } }
    }
    const cwd = j.record?.identity?.cwd
    const title = j.record?.rows?.title?.val
    return {
      cwd: typeof cwd === 'string' && cwd ? cwd : undefined,
      title: typeof title === 'string' && title ? title : undefined,
    }
  } catch {
    return {}
  }
}

export function discoverDshSessions(opts: DshDiscoverOptions): DshSession[] {
  const cacheDir = opts.cacheDir ?? defaultCacheDir()
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir()
  const maxAge = (opts.maxAgeDays ?? 5) * 24 * 3600_000
  const liveWindow = opts.liveWindowMs ?? 90_000
  const now = opts.nowMs ?? Date.now()
  const out: DshSession[] = []

  let files: { file: string; mtimeMs: number }[] = []
  try {
    files = readdirSync(cacheDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const file = join(cacheDir, f)
        try {
          return { file, mtimeMs: statSync(file).mtimeMs }
        } catch {
          return { file, mtimeMs: 0 }
        }
      })
      .filter((f) => f.mtimeMs > 0 && now - f.mtimeMs <= maxAge)
  } catch {
    return out
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const { file, mtimeMs } of files.slice(0, opts.max ?? 200)) {
    const { cwd, title } = readCache(file)
    if (!cwd || !underRoots(cwd, opts.roots)) continue
    const sessionId = basename(file, '.json')
    const fileT = sessionFileMtime(sessionsDir, sessionId)
    const lastActive = Math.max(mtimeMs, fileT ?? 0)
    out.push({
      sessionId,
      cwd,
      title: title ?? '',
      lastActive,
      userTurns: 0,
      running: Math.abs(now - lastActive) <= liveWindow,
      // 推断值：只有「确实刚动过」才敢说 busy，其余留空（不知道就别编）
      status: Math.abs(now - lastActive) <= liveWindow ? 'busy' : undefined,
    })
  }
  out.sort((a, b) => b.lastActive - a.lastActive)
  return out
}

export interface DshWorkspace {
  root: string
  label: string
  lastActive: number
}

/** 工作区候选：会话缓存里出现过的 cwd，限定在 allowRoots 内且目录还在。 */
export function discoverDshWorkspaces(opts: DshDiscoverOptions): DshWorkspace[] {
  const byPath = new Map<string, DshWorkspace>()
  for (const s of discoverDshSessionFiles(opts)) {
    const abs = resolve(s.cwd)
    if (!existsSync(abs)) continue
    const key = abs.toLowerCase()
    const cur = byPath.get(key)
    if (!cur) byPath.set(key, { root: abs, label: basename(abs), lastActive: s.lastActive })
    else if (s.lastActive > cur.lastActive) cur.lastActive = s.lastActive
  }
  return [...byPath.values()].sort((a, b) => b.lastActive - a.lastActive)
}

/** 只要 cwd 与时间的轻量版本（给工作区用，不查会话文件）。 */
function discoverDshSessionFiles(opts: DshDiscoverOptions): { cwd: string; lastActive: number }[] {
  const cacheDir = opts.cacheDir ?? defaultCacheDir()
  const maxAge = (opts.maxAgeDays ?? 5) * 24 * 3600_000
  const now = opts.nowMs ?? Date.now()
  const out: { cwd: string; lastActive: number }[] = []
  let files: string[] = []
  try {
    files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of files.slice(0, opts.max ?? 400)) {
    const file = join(cacheDir, f)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (now - mtimeMs > maxAge) continue
    const { cwd } = readCache(file)
    if (!cwd || !underRoots(cwd, opts.roots)) continue
    out.push({ cwd, lastActive: mtimeMs })
  }
  return out
}
