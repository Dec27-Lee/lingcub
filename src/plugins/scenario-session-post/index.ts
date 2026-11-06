/**
 * 话题内消息 → 已有会话追加一轮（bus 模式下旧 Pipeline 不再处理消息）。
 * 只投给已绑定、还活着的话题会话；命令、没有会话的消息一律不碰，交给其他场景。
 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event, Session } from '../../domain/types.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-session-post',
  roles: ['scenario'],
  wants: ['state.session.route', 'state.session.get', 'session.post'],
  on: ['message.received'],
  owns: ['messages'],
  config: z
    .object({
      /** 按事件 source 过滤，填真实 source id（'source-feishu-im' 这种），不是渠道名 */
      sources: z.array(z.string()).default(['source-feishu-im', 'source-feishu-card-v2']),
      skipPrefixes: z.array(z.string()).default(['#']),
    })
    .strict(),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as { sources: string[]; skipPrefixes: string[] }

  ctx.on('message.received', async (e) => {
    const event = e.payload as Event
    if (!cfg.sources.includes(event.source)) return
    const text = (event.text ?? '').trim()
    if (!text) return
    if (cfg.skipPrefixes.some((p) => text.startsWith(p))) return
    if (!ctx.has('state.session.route') || !ctx.has('session.post')) {
      ctx.log('warn', '缺少 state.session.route / session.post，跳过话题投递')
      return
    }

    const lookup = async (threadId: string | undefined): Promise<Session | null> => {
      if (!threadId) return null
      return ctx.call<Session | null>('state.session.route', { chatId: event.channel.id, threadId })
    }
    const session = (await lookup(event.threadId)) ?? (await lookup(event.rootId))
    if (!session) return
    if (session.status !== 'active' && session.status !== 'idle') return

    const r = await ctx.submit('session.post', { sessionId: session.id, text }, `post:${event.id}`)
    ctx.log('info', `话题投递 ${event.id} → 会话 ${session.id} receipt=${r.receiptId} status=${r.status}`)
  })
}
