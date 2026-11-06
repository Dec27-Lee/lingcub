/**
 * 钉钉消息 → 飞书独立群卡片。
 *
 * 每条钉钉事件（单聊、群消息、群 @我、我发出的历史轮询）都发一张卡到指定飞书群；
 * 卡片正文包含来源、发送人、会话和原消息内容。卡片由 channel-feishu 渲染为 notice。
 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event, MessageAnalysis } from '../../domain/types.ts'
import { renderImageText, type ImageLink } from '../../plugin-kit/dingtalk-media.ts'
import { formatDingTalkReport } from '../../plugin-kit/dingtalk-report.ts'
import { displaySender } from '../../plugin-kit/display-identity.ts'

const pendingCards = new Set<Promise<void>>()

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）`
}

/** 卡片统一显示北京时间（Asia/Shanghai），不把 UTC ISO 原样丢给用户。 */
export function formatBeijingTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

export function buildRelayCard(
  event: Event,
  maxChars = 3000,
  images: ImageLink[] = [],
  summary = '',
  content = event.text,
): Record<string, unknown> {
  const sender = displaySender(event.source, event.actor.name, event.actor.id)
  const group = event.channel.kind === 'group'
  const conversation = event.channel.name || (group ? '群聊' : sender)
  const rawText = (content || '[空消息/媒体消息]').trim()
  const text = renderImageText(rawText, images)
  const hhmm = formatBeijingTime(event.occurredAt).slice(11, 16)
  const title = group ? `${sender} · ${conversation} · ${hhmm}` : `${sender} · ${hhmm}`
  const elements: Record<string, unknown>[] = []
  if (text) elements.push({ tag: 'markdown', content: clip(text, maxChars) })
  for (const image of images) {
    if (image.imageKey) {
      elements.push({
        tag: 'img',
        img_key: image.imageKey,
        alt: { tag: 'plain_text', content: '图片' },
      })
    }
  }
  if (!text && !images.some((i) => i.imageKey)) {
    elements.push({ tag: 'markdown', content: '（空消息）' })
  }
  if (summary) {
    // 灰底色块直接承载总结，不加图标/标题，和正文用背景区分。
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'grey',
      horizontal_spacing: 'default',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'top',
          elements: [{ tag: 'markdown', content: clip(summary, 200) }],
        },
      ],
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template: group ? 'green' : 'blue',
      title: { tag: 'plain_text', content: title },
    },
    elements,
  }
}

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-dingtalk-feishu-relay',
  roles: ['scenario'],
  wants: ['notify.card.send', 'media.resolve'],
  on: ['distribution.decided'],
  owns: ['messages'],
  config: z
    .object({
      /** 飞书目标群 chat_id（oc_…）；机器人必须已在该群 */
      chatId: z.string().default(''),
      /** 用哪个频道插件发；默认现有 channel-feishu，独立 webhook 群填 channel-feishu-webhook */
      channel: z.string().default('channel-feishu'),
      /** 分发决策里出现这个出口才发卡 */
      target: z.string().default('feishu-card'),
      maxChars: z.number().int().positive().default(3000),
      /** 是否把「我发出的」也转过去；默认 true，符合“每一条” */
      includeOutgoing: z.boolean().default(true),
    })
    .strict(),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as {
    chatId: string
    channel: string
    target: string
    maxChars: number
    includeOutgoing: boolean
  }

  ctx.on('distribution.decided', (e) => {
    const payload = e.payload as {
      event: Event
      analysis: MessageAnalysis
      decision: { ruleId?: string; targets: string[] }
    }
    const event = payload.event
    const analysis = payload.analysis
    if (!payload.decision.targets.includes(cfg.target)) return
    if (event.source === 'source-dingtalk-sent' && !cfg.includeOutgoing) return
    if (!cfg.chatId && cfg.channel !== 'channel-feishu-webhook') {
      ctx.log('warn', '钉钉飞书转发未配置 chatId，跳过')
      return
    }
    if (!ctx.has('notify.card.send')) {
      ctx.log('warn', '缺少 notify.card.send，跳过钉钉飞书转发')
      return
    }

    // 图片下载/上传可能超过事件 5s 处理窗，不能阻塞 message.received；
    // 后台完成后再投递卡片，失败只记日志，不拖累其他场景。
    const task = (async () => {
      try {
        let images: ImageLink[] = []
        let content = event.text
        if (ctx.has('media.resolve')) {
          const media = await ctx.call<{ text: string; images: ImageLink[] }>('media.resolve', { event })
          images = media.images
          content = media.text
        } else {
          ctx.log('warn', '缺少 media.resolve，图片按占位符处理')
        }
        const display = formatDingTalkReport(content)
        const card = buildRelayCard(event, cfg.maxChars, images, analysis.summary, display)
        const r = await ctx.submit(
          'notify.card.send',
          { chatId: cfg.chatId || 'webhook', channel: cfg.channel, card },
          `dingtalk-relay:${event.id}`,
          { eventId: event.id },
        )
        ctx.log('info', `钉钉消息 ${event.externalId} → 飞书 ${cfg.chatId} receipt=${r.receiptId}`)
      } catch (err) {
        ctx.log('error', `钉钉消息转发失败 ${event.externalId}：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
    pendingCards.add(task)
    void task.finally(() => pendingCards.delete(task))
  })
}

export async function stop(_ctx: PluginContextV2): Promise<void> {
  await Promise.allSettled([...pendingCards])
}
