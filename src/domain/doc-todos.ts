/**
 * 文档待办的纯逻辑（P4c）：解析、认领、合并、拆分。
 * 不碰平台、不写文档；调用方负责读/写回与冲突重试。
 *
 * 行格式：`- [ ] [id] 文本` / `- [x] [id] 文本 [owner]`；owner 可省略。
 */

export interface DocTodo {
  id: string
  text: string
  done: boolean
  owner?: string
}

const LINE = /^- \[( |x|X)\] \[([^\]]+)\] (.+?)(?:\s+\[([^\]]*)\])?$/

export function parseTodos(markdown: string): DocTodo[] {
  const out: DocTodo[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const m = LINE.exec(line.trim())
    if (!m) continue
    const owner = m[4]?.trim()
    out.push({ id: m[2]!.trim(), text: m[3]!.trim(), done: m[1] !== ' ', ...(owner ? { owner } : {}) })
  }
  return out
}

export function renderTodos(items: readonly DocTodo[]): string {
  return items
    .map((t) => `- [${t.done ? 'x' : ' '}] [${t.id}] ${t.text}${t.owner ? ` [${t.owner}]` : ''}`)
    .join('\n')
}

/** 认领：别人已认领则冲突；已是自己的幂等成功；已完成不可认领。 */
export function claimTodo(
  items: readonly DocTodo[],
  id: string,
  owner: string,
): { items: DocTodo[]; ok: boolean; reason?: 'missing' | 'done' | 'taken' } {
  const i = items.findIndex((t) => t.id === id)
  if (i < 0) return { items: [...items], ok: false, reason: 'missing' }
  const cur = items[i]!
  if (cur.done) return { items: [...items], ok: false, reason: 'done' }
  if (cur.owner && cur.owner !== owner) return { items: [...items], ok: false, reason: 'taken' }
  const next = items.map((t, j) => (j === i ? { ...t, owner } : t))
  return { items: next, ok: true }
}

/** 合并：按 id 覆盖文本/完成态；已有 owner 不被空 owner 冲掉。 */
export function mergeTodos(existing: readonly DocTodo[], incoming: readonly DocTodo[]): DocTodo[] {
  const byId = new Map(existing.map((t) => [t.id, t]))
  for (const t of incoming) {
    const cur = byId.get(t.id)
    byId.set(t.id, {
      ...t,
      owner: t.owner ?? cur?.owner,
      done: t.done || (cur?.done ?? false),
    })
  }
  return [...byId.values()]
}

/** 拆分：按中英文句读/逗号切，超长再按长度硬切；去空、去重、保持顺序。 */
export function splitTodo(text: string, maxLen = 120): string[] {
  const parts = text
    .split(/[。；;，,、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    if (p.length <= maxLen) {
      if (!out.includes(p)) out.push(p)
      continue
    }
    for (let i = 0; i < p.length; i += maxLen) {
      const chunk = p.slice(i, i + maxLen).trim()
      if (chunk && !out.includes(chunk)) out.push(chunk)
    }
  }
  return out
}
