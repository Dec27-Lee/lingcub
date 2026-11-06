/**
 * 读 Claude Code 的转录（`~/.claude/projects/<slug>/<sessionId>.jsonl`），
 * 给「任务完成通知」补三样东西：上下文用量、你这一轮在终端里说的话。
 *
 * 只读文件，不碰网络；路径由调用方给，方便测试喂临时文件。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 整段就是系统产物：剥完什么都不剩，直接丢弃。 */
const PURE_SYSTEM = [
  /^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/,
  /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/,
  /^\s*<local-command-(?:caveat|stdout)>[\s\S]*$/,
  /^\s*<command-name>[\s\S]*$/,
  /^\s*\[Your previous response had no visible output[^\]]*\]\s*$/,
  /^\s*\[Request interrupted by user[^\]]*\]\s*$/,
  /^\s*This session is being continued[\s\S]*$/,
  /^\s*Caveat: The messages below were generated[\s\S]*$/,
]

/** 本来就是从飞书发来的：再推回飞书就是回音。 */
const FROM_FEISHU = ['【来自飞书】', '[来自用户本人 · 飞书]', 'Another Claude session sent a message']

/** 只剥包装、保留里面内容（这些是人产生的东西，不是系统噪声）。 */
export function unwrapPasted(text: string): string {
  return text
    .replace(/<pasted_content[^>]*>/g, '')
    .replace(/<\/pasted_content>/g, '')
    .replace(/\s*\[Image #\d+\]\s*/g, '\n')
    .replace(/\s*\[Image: [^\]]*\]\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((x): x is { type: string; text: string } => {
        const o = x as { type?: string; text?: unknown }
        return o?.type === 'text' && typeof o.text === 'string'
      })
      .map((x) => x.text)
      .join('\n')
  }
  return ''
}

/**
 * 从转录尾部反查「最后一条真正的人话」。
 *
 * 这一轮若本来就是从飞书发起的，**直接返回 null**（而不是继续往前翻）——
 * 往前翻会把上一轮终端里的输入顶上来，卡片上就顶着一句早已无关的话。
 */
export function lastUserInput(file: string, maxBytes = 4 * 1024 * 1024): string | null {
  let text: string
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const buf = readFileSync(file)
    text = buf.subarray(start).toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1) // 截断出来的第一行必然是半截 JSON
  } catch {
    return null
  }

  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.trim()) continue
    let d: { type?: string; isCompactSummary?: boolean; message?: { content?: unknown } }
    try {
      d = JSON.parse(line) as typeof d
    } catch {
      continue
    }
    if (!d || d.type !== 'user') continue
    if (d.isCompactSummary) continue

    const c = d.message?.content
    if (Array.isArray(c) && c.some((x) => (x as { type?: string })?.type === 'tool_result')) continue

    const raw = textOf(c).trim()
    if (!raw) continue
    if (PURE_SYSTEM.some((re) => re.test(raw))) continue

    const t = unwrapPasted(raw)
    if (!t) continue
    if (FROM_FEISHU.some((m) => t.includes(m))) return null
    return t
  }
  return null
}

/** 千位取整：222k 比 222.2k 紧凑 */
export function formatTokens(n: number, digits = 0): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
}

/**
 * 进度条：4 格，填充用 **floor**。
 * 用 round 的话 96% 也会画成满格，看起来像上下文已经爆了；floor 保证
 * 「满格 ⇔ 真的到顶」，百分数仍按 round 显示。
 */
export function contextBar(used: number, win: number): string {
  if (!win || win <= 0) return ''
  const ratio = Math.max(0, Math.min(1, used / win))
  const cells = 4
  const filled = Math.floor(ratio * cells)
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${Math.round(ratio * 100)}%`
}

export interface TranscriptStats {
  /** 最后一次请求的上下文占用（input + 两个 cache） */
  used: number
  /** 本会话累计 tokens */
  total: number
}

/** 统计缓存：状态卡 2 秒刷一次，同一个转录没必要每次全量重扫。 */
const statsCache = new Map<string, { mtimeMs: number; size: number; stats: TranscriptStats | null }>()

/** 扫转录统计用量；文件读不到返回 null（调用方就当没有这一行，不编数）。 */
export function transcriptStats(file: string): TranscriptStats | null {
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(file)
  } catch {
    return null
  }
  const hit = statsCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.stats
  const stats = scanTranscriptStats(file)
  statsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, stats })
  return stats
}

function scanTranscriptStats(file: string): TranscriptStats | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let lastUsage: Record<string, number> | null = null
  let total = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    try {
      const d = JSON.parse(line) as { message?: { usage?: Record<string, number> } }
      const u = d.message?.usage
      if (!u) continue
      lastUsage = u
      total += (u['input_tokens'] ?? 0) + (u['output_tokens'] ?? 0)
    } catch {
      /* 坏行跳过 */
    }
  }
  if (!lastUsage) return null
  const used =
    (lastUsage['input_tokens'] ?? 0) +
    (lastUsage['cache_read_input_tokens'] ?? 0) +
    (lastUsage['cache_creation_input_tokens'] ?? 0)
  return { used, total }
}

/** 用量那一行：`📦 ██░░ 21% 108k · Tokens 1.2M`（取不到就空串）。 */
export function statsLine(file: string | undefined, contextWindow: number): string {
  if (!file) return ''
  const s = transcriptStats(file)
  if (!s) return ''
  const parts: string[] = []
  const bar = contextBar(s.used, contextWindow)
  if (bar) parts.push(bar)
  parts.push(formatTokens(s.used))
  if (s.total) parts.push(`· Tokens ${formatTokens(s.total, 1)}`)
  return parts.join(' ')
}

/** 在 `~/.claude/projects/*` 下按会话 id 找转录文件；找不到返回 undefined。 */
export function findTranscript(sessionId: string | undefined, projectsDir?: string): string | undefined {
  if (!sessionId) return undefined
  const base = projectsDir ?? join(homedir(), '.claude', 'projects')
  if (!existsSync(base)) return undefined
  for (const slug of readdirSync(base)) {
    const p = join(base, slug, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return undefined
}

// ---- 状态卡要用的几项（都从转录尾部读，读不到就返回空，不编）----

export interface TurnInfo {
  /** 本轮最后一条助手正文 */
  said?: string
  /** 本轮改了哪些文件（去重） */
  files: string[]
  /** 本轮开始时间（最后一条 user 的时间戳） */
  startedAt?: string
  /** 最后一条 user 的 id（判断「是不是新的一轮」用） */
  userId?: string
  /** 本轮最后一次工具调用（状态卡上「🔧 正在用 X」那一行） */
  tool?: { name: string; detail?: string }
  /**
   * 本轮拉起来、还没结束的子任务。
   * 判据是「有没有对应的 tool_result」：Agent 的 tool_result 要等子代理跑完才出现，
   * 没闭合 = 还在跑。转录里这是唯一可靠的信号，不需要额外接口。
   */
  openSubtasks?: { name: string; what: string }[]
}

/** 会拉起后台工作的工具（参考项目 SUBTASK_TOOLS + run_in_background）。 */
const SUBTASK_TOOLS = new Set(['Agent', 'Task'])

/** 把一个工具调用描述成「子任务」；不是这类工具就返回 null。 */
export function describeSubtask(name: string, input?: Record<string, unknown>): { name: string; what: string } | null {
  const i = input ?? {}
  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const clip = (t: string): string => t.replace(/\s+/g, ' ').trim().slice(0, 60)
  if (SUBTASK_TOOLS.has(name)) {
    const type = str('subagent_type') || 'agent'
    return { name: type, what: clip(str('description') || str('prompt')) }
  }
  if (i['run_in_background']) {
    return { name: 'Bash', what: clip(str('description') || str('command')) }
  }
  return null
}

/** 这一行 user 消息是人打的吗？（工具结果回填不是） */
export function isHumanUserLine(line: string): boolean {
  try {
    const d = JSON.parse(line) as { message?: { content?: unknown } }
    const c = d.message?.content
    if (typeof c === 'string') return !c.includes('tool_result') && c.trim().length > 0
    if (!Array.isArray(c)) return false
    const blocks = c as { type?: string; text?: string }[]
    if (blocks.some((b) => b?.type === 'tool_result')) {
      // 全是工具结果 → 不是人打的；夹着文字才算（有些实现会把文字和结果放一起）
      return blocks.some((b) => b?.type === 'text' && (b.text ?? '').trim().length > 0)
    }
    return blocks.some((b) => b?.type === 'text' && (b.text ?? '').trim().length > 0)
  } catch {
    return false
  }
}

/** 只读尾部若干字节就够：状态卡 2 秒刷一次，不能整文件读。 */
function tailLines(file: string, maxBytes = 512 * 1024): string[] | null {
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - maxBytes)
    let text = readFileSync(file).subarray(start).toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return text.split('\n')
  } catch {
    return null
  }
}

/** 只看最后一条 user 之后的内容（= 本轮）。 */
export function currentTurn(file: string): TurnInfo {
  const lines = tailLines(file)
  if (!lines) return { files: [] }

  // 从后往前找最后一条**人**的 user，之前的都不算本轮。
  // user 行里还有一种是工具结果回填（content 全是 tool_result）——那不是人说的话，
  // 拿它当本轮开头会把这一轮的 tool_use 全漏掉（子任务就永远看不出来在跑）。
  let startIdx = 0
  let userId: string | undefined
  let startedAt: string | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.includes('"type":"user"') || !isHumanUserLine(line)) continue
    try {
      const d = JSON.parse(line) as { uuid?: string; timestamp?: string }
      userId = d.uuid
      startedAt = d.timestamp
      startIdx = i
      break
    } catch {
      continue
    }
  }

  const files = new Set<string>()
  let said: string | undefined
  let tool: { name: string; detail?: string } | undefined
  // 子任务的开启与关闭：tool_use 记一条，对应的 tool_result 出现就划掉
  const open = new Map<string, { name: string; what: string }>()
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.includes('"name":"Edit"') || line.includes('"name":"Write"') || line.includes('"name":"MultiEdit"') || line.includes('"name":"NotebookEdit"')) {
      for (const m of line.matchAll(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        if (m[1]) files.add(m[1])
      }
    }
    if (line.includes('"type":"assistant"')) {
      try {
        const d = JSON.parse(line) as { message?: { content?: unknown } }
        const t = textOf(d.message?.content).trim()
        if (t) said = t
        // 工具调用：取最后一个，带上最有信息量的一小段参数（命令 / 文件 / 模式）
        const blocks = Array.isArray(d.message?.content) ? (d.message!.content as unknown[]) : []
        for (const b of blocks) {
          const o = b as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
          if (o?.type !== 'tool_use' || !o.name) continue
          tool = { name: o.name, detail: toolDetail(o.name, o.input) }
          const sub = describeSubtask(o.name, o.input)
          if (sub && o.id) open.set(o.id, sub)
        }
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  // user 行里的 tool_result 就是「子任务跑完了」
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.includes('tool_result')) continue
    for (const m of line.matchAll(/"tool_use_id"\s*:\s*"([^"]+)"/g)) {
      if (m[1]) open.delete(m[1])
    }
  }
  return { said, files: [...files], startedAt, userId, tool, openSubtasks: [...open.values()] }
}

/** 工具调用的一小段摘要：命令行 / 文件 / 搜索词，够人看出「它在干什么」。 */
export function toolDetail(name: string, input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined
  const pick = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const short = (t: string, n = 60): string => (t.length > n ? `${t.slice(0, n)}…` : t)
  const file = pick('file_path') ?? pick('path') ?? pick('notebook_path')
  switch (name) {
    case 'Bash':
      return pick('command') ? short(String(input['command']), 80) : undefined
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? short(file.split(/[\\/]/).slice(-1)[0] ?? file, 40) : undefined
    case 'Grep':
    case 'Glob':
      return pick('pattern') ? short(String(input['pattern']), 40) : undefined
    case 'WebSearch':
    case 'WebFetch':
      return pick('query') ?? pick('url')
    default:
      return file ? short(file.split(/[\\/]/).slice(-1)[0] ?? file, 40) : undefined
  }
}

/** 毫秒转「已 X 分 Y 秒」这种紧凑写法。 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 秒'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/**
 * 转录里 claude 自己给这个会话起的名字（`aiTitle`，等价于 `/rename` 的结果）。
 * 首轮之前通常还没有；拿到之后状态卡/通知卡的标题就能用上真名字，
 * 而不是把用户第一句话原样当标题。
 */
export function transcriptTitle(file: string): string | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8').slice(-200_000)
  } catch {
    return undefined
  }
  // 后写的覆盖先写的：同一个键出现多次时取最后一次
  const picked = (re: RegExp): string | undefined => {
    let last: string | undefined
    for (const m of text.matchAll(re)) if (m[1]) last = m[1]
    return last
  }
  const custom = picked(/"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/g)
  const ai = picked(/"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/g)
  const title = custom ?? ai
  if (!title) return undefined
  try {
    return JSON.parse(`"${title}"`) as string
  } catch {
    return title
  }
}
/** 这一轮是不是还在跑。
 *
 * 钩子（Stop）偶尔会漏——用户窗口开着、turn 早就结束了，卡却一直显示「正在运行」。
 * 转录本身能回答：最后一条有内容的是「人说的话」或「助手发起工具调用还没回填」= 还在跑；
 * 最后一条是助手的正文收尾 = 本轮已经结束。
 */
export function isTurnOpen(file: string): boolean {
  const lines = tailLines(file)
  if (!lines) return false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    if (line.includes('"type":"user"')) {
      if (isHumanUserLine(line)) return true // 人刚说完，等回复 = 在跑
      continue // 工具结果回填，继续往前看
    }
    if (!line.includes('"type":"assistant"')) continue
    try {
      const d = JSON.parse(line) as { message?: { content?: unknown } }
      const blocks = d.message?.content
      if (!Array.isArray(blocks)) return false
      const hasToolUse = (blocks as { type?: string }[]).some((b) => b?.type === 'tool_use')
      if (hasToolUse) return true // 工具调用还没结果 = 在跑
      const text = (blocks as { type?: string; text?: string }[])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim()
      return text.length === 0 // 只有空正文（还在生成）= 在跑
    } catch {
      continue
    }
  }
  return false
}

