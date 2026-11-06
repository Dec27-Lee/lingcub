/**
 * 飞书群自定义机器人 webhook：用于独立机器人和独立群。
 * 不依赖 lark-cli 的 bot 身份；URL/secret 由群里的「自定义机器人」提供。
 */

import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Channel, SendResult } from '../../domain/ports.ts'

export interface WebhookConfig {
  url: string
  secret?: string
  timeoutMs: number
}

export function signFeishuWebhook(timestamp: number, secret: string): string {
  const key = `${timestamp}\n${secret}`
  return createHmac('sha256', key).update('').digest('base64')
}

/** 把内核的 notice 卡转成飞书自定义机器人可接受的旧版 interactive 卡。 */
export function renderWebhookCard(card: unknown): unknown {
  const c = card as { kind?: string; title?: string; body?: string; time?: string; schema?: string; header?: unknown }
  if (c?.schema || c?.header) return card
  if (c?.kind === 'notice') {
    return {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: c.title ?? '通知' } },
      elements: [
        { tag: 'markdown', content: c.time ? `🕐 ${c.time}` : '' },
        { tag: 'markdown', content: c.body ?? '' },
      ].filter((e) => e.content),
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '通知' } },
    elements: [{ tag: 'markdown', content: JSON.stringify(card).slice(0, 3000) }],
  }
}

export function createFeishuWebhookChannel(cfg: WebhookConfig, log: (level: 'info' | 'warn' | 'error', msg: string) => void): Channel {
  const post = async (payload: Record<string, unknown>): Promise<SendResult> => {
    if (!cfg.url) throw new Error('channel-feishu-webhook.url 未配置')
    const body: Record<string, unknown> = { ...payload }
    if (cfg.secret) {
      const timestamp = Math.floor(Date.now() / 1000)
      body.timestamp = String(timestamp)
      body.sign = signFeishuWebhook(timestamp, cfg.secret)
    }
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`飞书 webhook 失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
    log('info', `飞书 webhook 已发送（HTTP ${res.status}）`)
    return { status: 'sent' }
  }

  return {
    async send(a) {
      if (a.kind !== 'reply_only') throw new Error(`channel-feishu-webhook 不支持 ${a.kind}`)
      return post({ msg_type: 'text', content: { text: a.text } })
    },
    async sendCard(a) {
      return post({ msg_type: 'interactive', card: renderWebhookCard(a.card) })
    },
  }
}

export const manifest: ManifestV2 = {
  v: 2,
  id: 'channel-feishu-webhook',
  roles: ['channel'],
  config: z
    .object({
      url: z.string().default(''),
      secret: z.string().optional(),
      timeoutMs: z.number().int().positive().default(15_000),
    })
    .strict(),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as WebhookConfig
  ctx.registerPort(createFeishuWebhookChannel(cfg, (level, msg) => ctx.log(level, msg)))
}
