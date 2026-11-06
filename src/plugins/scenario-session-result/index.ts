/**
 * 飞书会话结果回执：会话结束后把执行器最后一段文本发回原会话。
 * 只处理 source 明确的飞书会话；钉钉回执由 dev-dispatch 负责，避免双发。
 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Session } from '../../domain/types.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-session-result',
  roles: ['scenario'],
  wants: ['state.session.get', 'notify.reply'],
  on: ['session.turn.ended'],
  config: z
    .object({
      sources: z.array(z.string()).default(['source-feishu-im', 'source-feishu-card-v2']),
      maxChars: z.number().int().positive().max(4000).default(1500),
    })
    .strict(),
}

/** 回执正文：保留换行与列表，只做长度保护（不是压成一行，用户要看的是答案本身）。 */
export function buildResultText(text: string, maxChars: number): string {
  const body = text.trim() || '已完成'
  if (body.length <= maxChars) return body
  return `${body.slice(0, maxChars)}…（超出 ${body.length - maxChars} 字，完整内容在窗口里）`
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as { sources: string[]; maxChars: number }
  ctx.on('session.turn.ended', async (e) => {
    const p = e.payload as { sessionId: string; text?: string }
    if (!ctx.has('state.session.get') || !ctx.has('notify.card.send')) return
    const session = await ctx.call<Session | null>('state.session.get', { sessionId: p.sessionId })
    if (!session?.source || !cfg.sources.includes(session.source)) return
    if (!session.chatId) return
    // 结果用**普通消息**发回话题：卡片的 markdown 会截断成一行，用户看不成答案
    const r = await ctx.submit(
      'notify.reply',
      {
        target: { channel: 'feishu', chatId: session.chatId, messageId: session.rootMessageId },
        text: buildResultText(p.text ?? '', cfg.maxChars),
      },
      `result:${e.id}`,
      { eventId: session.rootMessageId },
    )
    ctx.log('info', `飞书结果回执 ${session.id} receipt=${r.receiptId}`)
  })
}
