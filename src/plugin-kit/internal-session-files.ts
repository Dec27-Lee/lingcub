/**
 * 平台自己发起的一次性会话，转录文件落在哪、怎么按 id 删。
 *
 * 两个执行器各一套路径（实测 2026-11-09）：
 *   · claude：`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`
 *     （`--session-id` 是我们传的 uuid，文件名就是它）
 *   · dsh：`~/.dsh/sessions/<slug>/<session-id>/`（整个目录）
 *
 * **只按 id 删**：不按内容、不按 mtime 猜。谁是不是我们起的，由 `spawned_sessions` 表说了算。
 * 这样用户自己开的窗口记录永远不会被误删——它们的 id 不在表里。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SpawnDirs {
  /** claude 的 `~/.claude/projects` */
  claudeProjectsDir?: string
  /** dsh 的 `~/.dsh/sessions` */
  dshSessionsDir?: string
}

export function defaultSpawnDirs(home = homedir()): Required<SpawnDirs> {
  return {
    claudeProjectsDir: join(home, '.claude', 'projects'),
    dshSessionsDir: join(home, '.dsh', 'sessions'),
  }
}

/** 把 `<root>/<子目录>/<文件名>` 扫成 map：一次 readdir 建表，避免对大目录反复 exists。 */
function indexByFile(root: string | undefined, suffix: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!root || !existsSync(root)) return out
  let subs: string[]
  try {
    subs = readdirSync(root)
  } catch {
    return out
  }
  for (const sub of subs) {
    const dir = join(root, sub)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith(suffix)) continue
      out.set(name.slice(0, -suffix.length), join(dir, name))
    }
  }
  return out
}

export interface PurgeResult {
  /** 真的删掉了的 id */
  removed: string[]
  /** 文件本来就不在（也记成已清，下次不再查） */
  missing: string[]
  /** 删失败的 id（下次再试） */
  failed: { sessionId: string; error: string }[]
}

/** dsh 的会话是一个目录：`<root>/<slug>/<session-id>/`。 */
function indexDshSessions(root: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!root || !existsSync(root)) return out
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return out
  }
  for (const slug of slugs) {
    const dir = join(root, slug)
    let names: string[]
    try {
      if (!statSync(dir).isDirectory()) continue
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const p = join(dir, name)
      try {
        if (!statSync(p).isDirectory()) continue
      } catch {
        continue
      }
      out.set(name, p)
    }
  }
  return out
}

/**
 * 按 id 删一批一次性会话的转录。
 *
 * `records` 只该来自 `store.listSpawnsToPurge`——那是「我们自己起的」唯一权威清单。
 */
export function purgeSpawnFiles(
  records: readonly { sessionId: string; executor: string }[],
  dirs: SpawnDirs = defaultSpawnDirs(),
): PurgeResult {
  const result: PurgeResult = { removed: [], missing: [], failed: [] }
  if (!records.length) return result

  const claude = indexByFile(dirs.claudeProjectsDir, '.jsonl')
  const dsh = indexDshSessions(dirs.dshSessionsDir)

  for (const rec of records) {
    const path = rec.executor === 'dsh' ? dsh.get(rec.sessionId) : claude.get(rec.sessionId)
    if (!path) {
      result.missing.push(rec.sessionId)
      continue
    }
    try {
      rmSync(path, { recursive: rec.executor === 'dsh', force: true })
      result.removed.push(rec.sessionId)
    } catch (e) {
      result.failed.push({ sessionId: rec.sessionId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
