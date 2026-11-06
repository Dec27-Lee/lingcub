/**
 * 飞书会话历史：一次 lark-cli 查询，转成中间层统一的 HistoryItem。
 * 平台载荷只在这里解析；分析层不接触飞书字段。
 */

import type { HistoryItem, HistoryQuery } from '../domain/ports.ts'
import { runOnce } from './spawn.ts'

export interface FeishuHistoryConfig {
  enabled: boolean
  binary: string
  args: string[]
  timeoutMs: number
  /** lark-cli 的 --as：user 或 bot；独立群机器人不在群时用 user */
  identity: 'user' | 'bot'
}

function fillArgs(args: string[], q: HistoryQuery, identity: string): string[] {
  return args.map((arg) =>
    arg
      .replaceAll('{{chatId}}', q.channelId)
      .replaceAll('{{limit}}', String(Math.min(50, Math.max(1, q.limit))))
      .replaceAll('{{identity}}', identity),
  )
}

function parseTime(raw: unknown): string | undefined {
  if (typeof raw === 'number') return new Date(raw).toISOString()
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return new Date(`${s.replace(' ', 'T')}+08:00`).toISOString()
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

function parseBody(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const b = body as { content?: unknown; text?: unknown }
  if (typeof b.text === 'string') return b.text
  if (typeof b.content === 'string') {
    try {
      const parsed = JSON.parse(b.content) as { text?: unknown }
      if (typeof parsed.text === 'string') return parsed.text
    } catch {
      return b.content
    }
  }
  return ''
}

/** 飞书列表返回的是 newest-first；这里统一成 occurredAt 升序，并排除 before 及之后。 */
export function parseFeishuHistory(payload: unknown, before?: string): HistoryItem[] {
  const root = payload as { data?: { messages?: unknown[] } } | null
  const messages = root?.data?.messages
  if (!Array.isArray(messages)) return []
  const beforeMs = before ? Date.parse(before) : undefined
  const out: HistoryItem[] = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as {
      message_id?: unknown
      create_time?: unknown
      body?: unknown
      sender?: { id?: unknown; open_id?: unknown; name?: unknown }
    }
    const externalId = typeof m.message_id === 'string' ? m.message_id : undefined
    const occurredAt = parseTime(m.create_time)
    const text = parseBody(m.body).trim()
    if (!externalId || !occurredAt || !text || m.sender === undefined) continue
    if (beforeMs !== undefined && Date.parse(occurredAt) >= beforeMs) continue
    const id =
      typeof m.sender.open_id === 'string'
        ? m.sender.open_id
        : typeof m.sender.id === 'string'
          ? m.sender.id
          : 'unknown'
    out.push({
      externalId,
      occurredAt,
      actor: { id, name: typeof m.sender.name === 'string' ? m.sender.name : undefined },
      text,
    })
  }
  return out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
}

export async function fetchFeishuHistory(
  cfg: FeishuHistoryConfig,
  q: HistoryQuery,
): Promise<HistoryItem[] | undefined> {
  if (!cfg.enabled) return undefined
  const r = await runOnce({
    binary: cfg.binary,
    args: fillArgs(cfg.args, q, cfg.identity),
    timeoutMs: cfg.timeoutMs,
  })
  if (r.code !== 0) throw new Error(`飞书历史拉取失败（code=${r.code}）：${r.stderr.slice(0, 300)}`)
  return parseFeishuHistory(JSON.parse(r.stdout), q.before).slice(-q.limit)
}
