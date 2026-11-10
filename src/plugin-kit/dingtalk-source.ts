/** 钉钉来源的共享实现：实时 `+listen-im` 流和出站历史的轮询。 */

import { z } from 'zod'
import type { HistoryItem, HistoryQuery, Log, Source } from '../domain/ports.ts'
import type { ChannelKind, Event } from '../domain/types.ts'
import { eventId } from '../domain/ids.ts'
import { mapMessage, toIso } from './map.ts'
import { runOnce, spawnLines, type LineProcess } from './spawn.ts'

export const DingTalkFieldsSchema = z.object({
  externalId: z.string(),
  text: z.string(),
  channelId: z.string(),
  channelType: z.string().optional(),
  actorId: z.string(),
  occurredAt: z.string().optional(),
  actorName: z.string().optional(),
  channelName: z.string().optional(),
  threadId: z.string().optional(),
  replyTo: z.string().optional(),
  atMe: z.string().optional(),
})

export type DingTalkFields = z.infer<typeof DingTalkFieldsSchema>

export const DingTalkHistoryArgs = [
  'chat',
  '+chat-messages-list',
  '--open-conversation-id',
  '{{channelId}}',
  '--direction',
  'older',
  '--limit',
  '{{limit}}',
  '--no-reactions',
  '-f',
  'json',
] as const

export interface StreamConfig {
  source: string
  binary: string
  args: string[]
  fields: DingTalkFields
  groupValues: string[]
  fallbackChannelKind: ChannelKind
  /** 群消息事件通常只带 conversation_id；需要额外查一次群标题 */
  resolveGroupTitle?: boolean
  /** 会话历史命令模板，占位 {{channelId}} / {{limit}}；缺省只用平台事件库 */
  historyArgs?: string[]
  log: Log
}

/** 去掉可能的 transport envelope；`+listen-im` 多数是扁平事件，`event consume` 会包一层 data。 */
export function unwrapDingTalk(payload: unknown): unknown {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'data' in payload &&
    typeof (payload as { data?: unknown }).data === 'object' &&
    (payload as { data?: unknown }).data !== null
  ) {
    return (payload as { data: unknown }).data
  }
  return payload
}

export function createDingTalkStream(cfg: StreamConfig): Source {
  let proc: LineProcess | null = null
  const titleCache = new Map<string, Promise<string | undefined>>()
  const resolveTitle = (id: string): Promise<string | undefined> => {
    const cached = titleCache.get(id)
    if (cached) return cached
    const p = runOnce({
      binary: cfg.binary,
      args: ['chat', '+conversation-info', '--group', id, '-f', 'json'],
      timeoutMs: 15_000,
    })
      .then((r) => {
        if (r.code !== 0) return undefined
        const parsed = JSON.parse(r.stdout) as { result?: { conversationInfo?: { title?: string } } }
        return parsed.result?.conversationInfo?.title
      })
      .catch(() => undefined)
    titleCache.set(id, p)
    return p
  }

  return {
    async start(emit) {
      proc = spawnLines({
        binary: cfg.binary,
        args: cfg.args,
        log: cfg.log,
        onStderr: (line) => cfg.log('debug', `stderr: ${line}`),
        onExit: (code) => cfg.log(code === 0 ? 'info' : 'warn', `钉钉来源退出：code=${code}`),
        onLine: (line) => {
          let payload: unknown
          try {
            payload = JSON.parse(line) as unknown
          } catch {
            cfg.log('debug', '钉钉：非 JSON 行，跳过')
            return
          }
          const mapped = mapMessage(unwrapDingTalk(payload), {
            source: cfg.source,
            fields: cfg.fields,
            groupValues: cfg.groupValues,
            fallbackChannelKind: cfg.fallbackChannelKind,
          })
          if (!mapped.ok) {
            cfg.log(
              'warn',
              `钉钉事件缺字段，跳过：${mapped.missing.join(', ')}；payload 顶层键：${mapped.keys.join(', ')}`,
            )
            return
          }
          const event = { ...mapped.event, id: eventId(cfg.source, mapped.event.externalId) }
          if (!event.channel.name) {
            if (event.channel.kind === 'dm') event.channel.name = event.actor.name
            else if (cfg.resolveGroupTitle) {
              void resolveTitle(event.channel.id).then((title) => {
                if (title) event.channel.name = title
                emit(event)
              })
              return
            }
          }
          emit(event)
        },
      })
    },
    async stop() {
      await proc?.stop()
      proc = null
    },
    async fetchHistory(q: HistoryQuery): Promise<HistoryItem[] | undefined> {
      if (!cfg.historyArgs?.length) return undefined
      const args = cfg.historyArgs.map((a) =>
        a.replaceAll('{{channelId}}', q.channelId).replaceAll('{{limit}}', String(q.limit)),
      )
      return fetchDingTalkHistory({ binary: cfg.binary, args, log: cfg.log }, q)
    },
  }
}

export async function fetchDingTalkHistory(
  cfg: { binary: string; args: string[]; log: Log },
  q: HistoryQuery,
): Promise<HistoryItem[] | undefined> {
  const r = await runOnce({ binary: cfg.binary, args: cfg.args, timeoutMs: 30_000 })
  if (r.code !== 0) {
    cfg.log('warn', `钉钉会话历史失败（code=${r.code}）：${r.stderr.trim().slice(0, 300)}`)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    cfg.log('warn', '钉钉会话历史返回非 JSON')
    return undefined
  }
  const raw = (parsed as { messages?: unknown[] }).messages
  if (!Array.isArray(raw)) return undefined
  const before = q.before ? new Date(q.before).getTime() : Number.POSITIVE_INFINITY
  const items: HistoryItem[] = []
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) continue
    const row = m as {
      messageId?: string
      text?: string
      content?: string
      sender?: string
      senderId?: string
      createTime?: string
    }
    const at = row.createTime ? new Date(row.createTime).getTime() : Number.NaN
    if (Number.isFinite(at) && at >= before) continue
    items.push({
      externalId: row.messageId ?? '',
      actor: { id: row.senderId ?? row.sender ?? 'unknown', name: row.sender },
      text: row.text ?? row.content ?? '',
      occurredAt: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString(),
    })
  }
  items.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.externalId.localeCompare(b.externalId))
  return items.slice(-q.limit)
}

export interface SentConfig {
  source: string
  binary: string
  /** 模板，占位 start/end；通常 `chat message list-all --start {{start}} --end {{end}} --page-all --no-reactions -f json` */
  args: string[]
  /** 自己的 openDingTalkId；历史里的 senderId 与之一致才算“我发的” */
  selfId?: string
  fields: DingTalkFields
  intervalMs: number
  lookbackMinutes: number
  historyArgs?: string[]
  log: Log
}

function formatTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface HistoryMessage {
  text?: string
  content?: string
  messageId?: string
  conversationId?: string
  openConversationId?: string
  conversationTitle?: string
  createTime?: string
  senderId?: string
  senderOpenDingTalkId?: string
  sender?: string
  singleChat?: boolean
}

function historyMessages(parsed: unknown): HistoryMessage[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const result = (parsed as { result?: { conversationMessagesList?: unknown[] } }).result
  const list = result?.conversationMessagesList
  if (!Array.isArray(list)) return []
  const out: HistoryMessage[] = []
  for (const conv of list) {
    if (typeof conv !== 'object' || conv === null) continue
    const messages = (conv as { messages?: unknown[] }).messages
    if (!Array.isArray(messages)) continue
    for (const m of messages) if (typeof m === 'object' && m !== null) out.push(m as HistoryMessage)
  }
  return out
}

export function createDingTalkSent(cfg: SentConfig): Source {
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let lastEnd = new Date(Date.now() - cfg.lookbackMinutes * 60_000)
  let ticking = false

  const tick = async (emit: (e: Event) => void): Promise<void> => {
    if (!cfg.selfId) {
      cfg.log('warn', '钉钉出站来源未配置 selfId，跳过历史轮询')
      return
    }
    if (ticking || stopped) return
    ticking = true
    try {
      const start = new Date(lastEnd.getTime() - 60_000)
      const end = new Date()
      const args = cfg.args.map((a) => a.replaceAll('{{start}}', formatTime(start)).replaceAll('{{end}}', formatTime(end)))
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: 30_000 })
      if (r.code !== 0) {
        cfg.log('warn', `钉钉出站历史轮询失败（code=${r.code}）：${r.stderr.trim().slice(0, 300)}`)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(r.stdout)
      } catch {
        cfg.log('warn', '钉钉出站历史返回非 JSON，跳过本轮')
        return
      }
      for (const m of historyMessages(parsed)) {
        const senderId = m.senderId ?? m.senderOpenDingTalkId
        if (!senderId || senderId !== cfg.selfId) continue
        const externalId = m.messageId
        if (!externalId) continue
        const mapped = mapMessage(m, {
          source: cfg.source,
          fields: cfg.fields,
          groupValues: [],
          fallbackChannelKind: m.singleChat ? 'dm' : 'group',
          now: () => new Date(),
        })
        if (!mapped.ok) continue
        emit({
          ...mapped.event,
          id: eventId(cfg.source, externalId),
          occurredAt: toIso(m.createTime, mapped.event.occurredAt),
          text: m.text ?? m.content ?? '',
        })
      }
      lastEnd = end
    } finally {
      ticking = false
    }
  }

  return {
    async start(emit) {
      stopped = false
      await tick(emit)
      timer = setInterval(() => {
        void tick(emit)
      }, cfg.intervalMs)
      timer.unref()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    },
    async fetchHistory(q: HistoryQuery): Promise<HistoryItem[] | undefined> {
      if (!cfg.historyArgs?.length) return undefined
      const args = cfg.historyArgs.map((a) =>
        a.replaceAll('{{channelId}}', q.channelId).replaceAll('{{limit}}', String(q.limit)),
      )
      return fetchDingTalkHistory({ binary: cfg.binary, args, log: cfg.log }, q)
    },
  }
}
