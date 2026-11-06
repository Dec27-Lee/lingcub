/** 平台事件 → Event 的公共映射。字段名是平台事实，由各 source 插件的 config.fields 声明。 */

import type { ChannelKind, Event } from '../domain/types.ts'
import { extractImageKeys } from '../domain/images.ts'
import { pickScalar } from './pick.ts'

export interface MessageFields {
  /** 平台消息唯一 id，Event 幂等的依据 */
  externalId: string
  /** 正文 */
  text: string
  channelId: string
  /** dm/group 由该字段的取值与 groupValues 比对得出 */
  channelType?: string
  actorId: string
  occurredAt?: string
  actorName?: string
  channelName?: string
  /** 话题根消息 id；有它才能把消息路由回某个会话 */
  threadId?: string
  rootId?: string
  replyTo?: string
  /** 是否 @ 了我；平台不给就留空 → atMe 规则不命中，而不是猜成 true */
  atMe?: string
  /** 图片消息里 image_key 的路径；有它就把正文换成统一标记 */
  imageKey?: string
}

export interface MapOptions<F extends MessageFields> {
  source: string
  fields: F
  /** channelType 命中这些取值即群聊，否则按私聊处理 */
  groupValues: readonly string[]
  /** 平台不给 channelType 时（例如 +listen-im all-direct）由来源声明的固定会话类型 */
  fallbackChannelKind?: ChannelKind
  now?: () => Date
}

export type Mapped = { ok: true; event: Event } | { ok: false; missing: string[]; keys: string[] }

/** 13 位毫秒数也常见于国内平台；按「纯数字且够长」判定，其余原样当 ISO 字符串。 */
export function toIso(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  if (/^\d{10}$/.test(value)) return new Date(Number(value) * 1000).toISOString()
  if (/^\d{13}$/.test(value)) return new Date(Number(value)).toISOString()
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString()
}

export function mapMessage<F extends MessageFields>(payload: unknown, opts: MapOptions<F>): Mapped {
  const f = opts.fields
  const nowIso = (opts.now?.() ?? new Date()).toISOString()
  const missing: string[] = []
  const need = (label: string, path: string): string => {
    const v = pickScalar(payload, path)
    if (v === undefined) missing.push(`${label}(${path})`)
    return v ?? ''
  }

  const externalId = need('externalId', f.externalId)
  const text = need('text', f.text)
  const channelId = need('channelId', f.channelId)
  const channelType = f.channelType ? pickScalar(payload, f.channelType) : undefined
  if (channelType === undefined && !opts.fallbackChannelKind) {
    missing.push(`channelType(${f.channelType ?? '(未声明)'})`)
  }
  const actorId = need('actorId', f.actorId)

  if (missing.length) {
    const keys = payload && typeof payload === 'object' ? Object.keys(payload as object) : []
    return { ok: false, missing, keys }
  }

  const atMeRaw = f.atMe === undefined ? undefined : pickScalar(payload, f.atMe)
  const channelKind: ChannelKind =
    opts.fallbackChannelKind ?? (opts.groupValues.includes(channelType ?? '') ? 'group' : 'dm')

  return {
    ok: true,
    event: {
      id: '',
      source: opts.source,
      externalId,
      receivedAt: nowIso,
      occurredAt: toIso(f.occurredAt ? pickScalar(payload, f.occurredAt) : undefined, nowIso),
      atMe: atMeRaw === undefined ? undefined : atMeRaw === 'true' || atMeRaw === '1',
      actor: {
        id: actorId,
        name: f.actorName ? pickScalar(payload, f.actorName) : undefined,
      },
      channel: {
        kind: channelKind,
        id: channelId,
        name: f.channelName ? pickScalar(payload, f.channelName) : undefined,
      },
      threadId: f.threadId ? pickScalar(payload, f.threadId) || undefined : undefined,
      rootId: f.rootId ? pickScalar(payload, f.rootId) || undefined : undefined,
      replyTo: f.replyTo ? pickScalar(payload, f.replyTo) || undefined : undefined,
      imageKey: f.imageKey ? pickScalar(payload, f.imageKey) : undefined,
      // 图文消息（post）里图是 markdown 标记，正文里能抽出几张就带几张
      imageKeys: (() => {
        const keys = extractImageKeys(text)
        return keys.length ? keys : undefined
      })(),
      text,
      raw: payload,
    },
  }
}
