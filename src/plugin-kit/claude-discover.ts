/**
 * 扫出这台机器上「真的用过/登记过」的工作区——不是预设清单。
 *
 * 三处来源（与参考项目 discoverWorkspaces 对齐）：
 *   1. `~/.claude.json` 里 `projects` 登记的目录（最全，含很久没打开的）
 *   2. `~/.claude/projects/<slug>/<session>.jsonl` 转录里的 `cwd`（带最近活动时间）
 *   3. 调用方显式补进来的目录（配置里声明的）
 * 只保留落在 allowRoots 内的：执行器本来就只能在那些根下面干活，列出来点不动等于骗人。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

export interface Discovered {
  root: string
  label: string
  lastActive: number
}

const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()

/** 是否落在某个允许根之下（含根本身）。 */
export function underRoots(path: string, roots: readonly string[]): boolean {
  const p = norm(path)
  return roots.some((r) => {
    const root = norm(r)
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
  })
}

/** 从转录尾部抽最后一个 `"cwd":"…"`（只读尾部，别把几十 MB 读进来）。 */
export function lastCwd(file: string): string | undefined {
  try {
    const size = statSync(file).size
    const fh = readFileSync(file)
    const tail = fh.subarray(Math.max(0, size - 64 * 1024)).toString('utf8')
    const all = [...tail.matchAll(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
    const raw = all.at(-1)?.[1]
    if (!raw) return undefined
    return raw.replace(/\\\\/g, '\\').replace(/\\"/g, '"')
  } catch {
    return undefined
  }
}

export function discover(opts: {
  roots: readonly string[]
  extra?: readonly string[]
  claudeJson?: string
  projectsDir?: string
}): Discovered[] {
  const byPath = new Map<string, Discovered>()
  const add = (path: string, lastActive: number): void => {
    if (!path) return
    const abs = resolve(path)
    if (!existsSync(abs)) return
    if (!underRoots(abs, opts.roots)) return
    const key = norm(abs)
    const cur = byPath.get(key)
    if (!cur) byPath.set(key, { root: abs, label: basename(abs), lastActive })
    else if (lastActive > cur.lastActive) cur.lastActive = lastActive
  }

  const claudeJson = opts.claudeJson ?? join(homedir(), '.claude.json')
  if (existsSync(claudeJson)) {
    try {
      const j = JSON.parse(readFileSync(claudeJson, 'utf8')) as { projects?: Record<string, unknown> }
      for (const p of Object.keys(j.projects ?? {})) add(p, 0)
    } catch {
      /* 配置坏了就当没有，别让开窗挂掉 */
    }
  }

  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects')
  if (existsSync(projectsDir)) {
    for (const dir of readdirSync(projectsDir)) {
      const p = join(projectsDir, dir)
      let files: { f: string; t: number }[] = []
      try {
        files = readdirSync(p)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => {
            try {
              return { f: join(p, f), t: statSync(join(p, f)).mtimeMs }
            } catch {
              return { f: join(p, f), t: 0 }
            }
          })
      } catch {
        continue
      }
      files.sort((a, b) => b.t - a.t)
      for (const f of files.slice(0, 8)) {
        const cwd = lastCwd(f.f)
        if (cwd) add(cwd, f.t)
      }
    }
  }

  for (const extra of opts.extra ?? []) add(extra, 0)

  return [...byPath.values()].sort((a, b) => b.lastActive - a.lastActive)
}

// ---- 历史会话发现（对应参考项目 discoverSessions）----
// 每个会话的元数据都在转录里：`cwd` 是工作目录、首条 user 消息可当标题、
// 文件 mtime 是最近活动时间。只读尾部，别把几十 MB 读进来。

export interface SessionHistory {
  sessionId: string
  cwd: string
  title: string
  lastActive: number
  userTurns: number
  /** 现在是不是还在跑（同一会话不能被两个进程同时持有） */
  running: boolean
  /** 平台/注册表给的忙闲；没有就不填 */
  status?: 'busy' | 'idle'
}

/** 正在跑的 claude 会话 id（读 `~/.claude/sessions/*.json`）。 */
export function runningSessionIds(sessionsDir?: string): Set<string> {
  const dir = sessionsDir ?? join(homedir(), '.claude', 'sessions')
  const out = new Set<string>()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { sessionId?: string; status?: string }
      if (typeof j.sessionId !== 'string') continue
      // busy/idle 都算「活着」；closed 之类不算
      if (j.status === 'busy' || j.status === 'idle') out.add(j.sessionId)
    } catch {
      /* 单个文件坏了不影响整体 */
    }
  }
  return out
}

/**
 * 从转录尾部抽标题与轮到数。
 * 标题优先用 claude 自己写的 `aiTitle`（等同 `/rename` 的名字）；没有才退回首条 user 文本。
 * 参考项目的口径也是这样——首条 user 常常是 `<local-command-caveat>` 这类噪音。
 */
export function transcriptMeta(file: string): { title: string; userTurns: number; cwd?: string } {
  try {
    const size = statSync(file).size
    if (size < 200) return { title: '', userTurns: 0 }
    const start = Math.max(0, size - 200_000)
    const buf = readFileSync(file).subarray(start)
    const text = buf.toString('utf8')

    const pickLast = (re: RegExp): string | undefined => {
      const all = [...text.matchAll(re)]
      const raw = all.at(-1)?.[1]
      if (!raw) return undefined
      try {
        return JSON.parse(`"${raw}"`) as string
      } catch {
        return raw
      }
    }

    const aiTitle = pickLast(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)
    const cwd = pickLast(/"cwd":"((?:[^"\\]|\\.)*)"/g)
    const userTurns = (text.match(/"type":"user"/g) ?? []).length

    let title = aiTitle ?? ''
    if (!title) {
      // 首条 user 文本兜底，但过滤掉明显的系统噪音
      for (const line of text.split('\n')) {
        if (!line.includes('"type":"user"')) continue
        try {
          const j = JSON.parse(line) as { message?: { content?: unknown } }
          const c = j.message?.content
          const raw = typeof c === 'string' ? c : Array.isArray(c) ? (c[0] as { text?: string } | undefined)?.text : ''
          const t = (raw ?? '').trim()
          if (t && !t.startsWith('<')) {
            title = t.replace(/\s+/g, ' ').slice(0, 40)
            break
          }
        } catch {
          /* 跳过坏行 */
        }
      }
    }
    return { title, userTurns, cwd }
  } catch {
    return { title: '', userTurns: 0 }
  }
}

/**
 * 近 `maxAgeDays` 天有活动的会话。
 * 与参考项目一致：running 的也返回（由上层标注「运行中」并禁用选择）。
 */
export function discoverSessions(opts: {
  roots: readonly string[]
  projectsDir?: string
  sessionsDir?: string
  maxAgeDays?: number
  max?: number
}): SessionHistory[] {
  const base = opts.projectsDir ?? join(homedir(), '.claude', 'projects')
  const maxAge = (opts.maxAgeDays ?? 5) * 24 * 3600_000
  const now = Date.now()
  const running = runningSessionIds(opts.sessionsDir)
  const out: SessionHistory[] = []
  if (!existsSync(base)) return out

  for (const slug of readdirSync(base)) {
    const dir = join(base, slug)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const file = join(dir, f)
      let st: { mtimeMs: number }
      try {
        st = statSync(file)
      } catch {
        continue
      }
      if (now - st.mtimeMs > maxAge) continue
      const cwd = lastCwd(file)
      if (!cwd || !underRoots(cwd, opts.roots)) continue
      const meta = transcriptMeta(file)
      out.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        cwd: meta.cwd ?? cwd,
        title: meta.title,
        lastActive: st.mtimeMs,
        userTurns: meta.userTurns,
        running: running.has(f.replace(/\.jsonl$/, '')),
      })
    }
  }
  out.sort((a, b) => b.lastActive - a.lastActive)
  return out.slice(0, opts.max ?? 20)
}

/**
 * 正在跑的会话：注册目录里登记过、且进程还活着的那些。
 *
 * 用来「把飞书话题接到一个已经在跑的窗口上」——不是恢复（`--resume` 会另起一个），
 * 而是直接对这个进程投递。所以这里必须只列真的活着的，否则点下去就是死绑。
 */
export function discoverLiveSessions(opts: {
  roots: readonly string[]
  projectsDir?: string
  sessionsDir?: string
  maxAgeDays?: number
}): SessionHistory[] {
  const dir = opts.sessionsDir ?? join(homedir(), '.claude', 'sessions')
  const base = opts.projectsDir ?? join(homedir(), '.claude', 'projects')
  const maxAge = (opts.maxAgeDays ?? 5) * 24 * 3600_000
  const out: SessionHistory[] = []
  if (!existsSync(dir)) return out

  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        sessionId?: string
        pid?: number
        cwd?: string
      }
      if (!j.sessionId || !j.pid || !j.cwd) continue
      if (!underRoots(j.cwd, opts.roots)) continue
      // 进程不在了就不是「在跑」：列出来点了也投不进去
      try {
        process.kill(j.pid, 0)
      } catch {
        continue
      }
      // 找到它的转录，拿标题与最近活动时间
      const file = findTranscriptOf(base, j.sessionId)
      const meta = file ? transcriptMeta(file) : undefined
      const mtime = file ? statSync(file).mtimeMs : Date.now()
      if (Date.now() - mtime > maxAge) continue
      out.push({
        sessionId: j.sessionId,
        cwd: j.cwd,
        title: meta?.title ?? '',
        lastActive: mtime,
        userTurns: meta?.userTurns ?? 0,
        running: true,
      })
    } catch {
      /* 坏登记跳过 */
    }
  }
  out.sort((a, b) => b.lastActive - a.lastActive)
  return out
}

// ---- 官方列举入口（`claude agents --json`，2026-11-06 实测）----
// 比读注册表更可靠：直接给 pid / 全 uuid / cwd / kind / name / status(busy|idle)，
// 而且能看到用户自己在终端里开的会话。读注册表仍是 CLI 不可用时的兜底。

export interface AgentRecord {
  pid: number
  sessionId: string
  cwd: string
  kind: string
  name: string
  status?: 'busy' | 'idle'
  startedAt?: number
}

/** 解析 `claude agents --json` 的输出；坏行一律跳过，不抛。 */
export function parseAgentsJson(text: string): AgentRecord[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: AgentRecord[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const sessionId = typeof r['sessionId'] === 'string' ? r['sessionId'] : ''
    const cwd = typeof r['cwd'] === 'string' ? r['cwd'] : ''
    if (!sessionId || !cwd) continue
    const status = r['status']
    out.push({
      pid: typeof r['pid'] === 'number' ? r['pid'] : 0,
      sessionId,
      cwd,
      kind: typeof r['kind'] === 'string' ? r['kind'] : '',
      name: typeof r['name'] === 'string' ? r['name'] : '',
      status: status === 'busy' || status === 'idle' ? status : undefined,
      startedAt: typeof r['startedAt'] === 'number' ? r['startedAt'] : undefined,
    })
  }
  return out
}

/** 把 agents 记录转成端口契约的历史会话（只保留 allowRoots 内的）。 */
export function liveFromAgents(
  records: readonly AgentRecord[],
  opts: { roots: readonly string[]; maxAgeDays?: number; nowMs?: number },
): SessionHistory[] {
  const maxAge = (opts.maxAgeDays ?? 5) * 24 * 3600_000
  const now = opts.nowMs ?? Date.now()
  const out: SessionHistory[] = []
  for (const a of records) {
    if (!underRoots(a.cwd, opts.roots)) continue
    const lastActive = a.startedAt ?? now
    if (now - lastActive > maxAge) continue
    out.push({
      sessionId: a.sessionId,
      cwd: a.cwd,
      title: a.name,
      lastActive,
      userTurns: 0,
      running: true,
      status: a.status,
    })
  }
  out.sort((a, b) => b.lastActive - a.lastActive)
  return out
}

/** 在 `~/.claude/projects/*` 下按会话 id 找转录文件。 */
function findTranscriptOf(base: string, sessionId: string): string | undefined {
  let slugs: string[] = []
  try {
    slugs = readdirSync(base)
  } catch {
    return undefined
  }
  for (const slug of slugs) {
    const p = join(base, slug, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return undefined
}
