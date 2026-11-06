/** P2.6：内核发 session.ready 后，由场景渲染「窗口已创建」卡片，不再让内核拼飞书卡片。 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { SessionReady } from '../../domain/types.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-session-ready',
  roles: ['scenario'],
  on: ['session.ready'],
  wants: ['notify.card.send'],
  config: z.object({}).strict(),
}

export function setup(ctx: PluginContextV2): void {
  ctx.on('session.ready', async (e) => {
    const p = e.payload as SessionReady
    if (!p.chatId || !ctx.has('notify.card.send')) return
    // 钉钉最终回执由钉钉场景负责；没有来源的旧路径默认按飞书处理。
    if (p.source && p.source !== 'source-feishu-im') return
    await ctx.submit(
      'notify.card.send',
      {
        chatId: p.chatId,
        replyTo: p.rootMessageId,
        card: {
          kind: 'ready',
          title: `窗口已创建：${p.title?.trim() || p.sessionId.slice(0, 8)}`,
          cwd: p.cwd,
          sessionId: p.sessionId,
          threadId: p.threadId,
          rootMessageId: p.rootMessageId,
          chatId: p.chatId,
        },
      },
      `ready:${p.requestId}`,
    )
  })
}
