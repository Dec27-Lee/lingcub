/**
 * 派工出口：消费分发决策，用中间层分析直接生成 Intent，不再重复跑模型判断。
 * 只有 distribution.decided 的目标包含 dispatch 才派工；回复目标只从该消息创建的会话取。
 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event, Intent, Session } from '../../domain/types.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-dev-dispatch',
  roles: ['scenario'],
  wants: ['task.open', 'state.session.get', 'transport.dingtalk.send'],
  on: ['distribution.decided', 'session.turn.ended', 'confirmation.requested'],
  owns: ['messages'],
  config: z
    .object({
      project: z.string().min(1),
      /** distribution.decided.targets 里出现这个出口才派工 */
      target: z.string().default('dispatch'),
      replyTemplate: z.string().default('已处理：{{summary}}'),
      replyMaxChars: z.number().int().positive().default(80),
      /** pipeline=旧开窗；terminal/headless=发 session.open.requested 给执行器插件 */
      openMode: z.enum(['pipeline', 'terminal', 'headless']).default('pipeline'),
      suggestTemplate: z
        .string()
        .default('建议派工：{{project}}\n确认后回复「执行」才会真的开工（当前建议档不自动派工）。'),
    })
    .strict(),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as {
    project: string
    target: string
    replyTemplate: string
    replyMaxChars: number
    openMode: 'pipeline' | 'terminal' | 'headless'
    suggestTemplate: string
  }

  ctx.on('distribution.decided', async (e) => {
    const payload = e.payload as {
      event: Event
      analysis: { summary?: string; status?: string }
      decision: { targets?: string[] }
    }
    const event = payload.event
    if (!payload.decision.targets?.includes(cfg.target)) return
    if (payload.analysis.status !== 'ok') {
      ctx.log('warn', `分发目标含 ${cfg.target} 但分析降级，跳过派工 ${event.id}`)
      return
    }
    if (!ctx.has('task.open')) {
      ctx.log('warn', '缺少 task.open，跳过派工')
      return
    }
    // 模型只负责中间层 understanding；路由已由 distribution 规则决定，这里用配置生成 Intent。
    const intent: Intent = {
      eventId: event.id,
      kind: 'dev-request',
      topic: (payload.analysis.summary || event.text || '消息派工').replace(/\s+/g, ' ').slice(0, 120),
      project: cfg.project,
      suggestedAction: 'dispatch_session',
      rationale: 'distribution 命中 dispatch 出口',
      confidence: 0.95,
    }
    const via = cfg.openMode === 'pipeline' ? 'pipeline' : 'event'
    const mode = cfg.openMode === 'headless' ? 'headless' : 'terminal'
    const r = await ctx.submit(
      'task.open',
      { event, intent, dispatch: true, via, mode },
      `dev:${event.id}`,
      { eventId: event.id },
    )
    ctx.log(
      'info',
      `派工 ${event.id} → receipt=${r.receiptId} status=${r.status}${r.duplicate ? '（重复）' : ''}`,
    )
  })

  // 建议档：task.open 被闸住时，给反馈人一条建议（通知类已由策略闸放行）。
  ctx.on('confirmation.requested', async (e) => {
    const p = e.payload as {
      confirmationId: number
      caller: string
      name: string
      input?: { event?: Event; intent?: Intent }
    }
    if (p.name !== 'task.open' || p.caller !== ctx.id) return
    const event = p.input?.event
    const intent = p.input?.intent
    if (!event || !intent) return
    if (!ctx.has('transport.dingtalk.send')) {
      ctx.log('warn', '缺少 transport.dingtalk.send，跳过建议回执')
      return
    }
    const text = cfg.suggestTemplate.replaceAll('{{project}}', intent.project ?? cfg.project)
    await ctx.submit(
      'transport.dingtalk.send',
      {
        target: {
          openDingtalkId: event.actor.id,
          messageId: event.externalId,
          conversationId: event.channel.id,
        },
        text,
      },
      `suggest:${p.confirmationId}`,
      { eventId: event.id },
    )
  })

  ctx.on('session.turn.ended', async (e) => {
    const p = e.payload as { sessionId: string; text?: string }
    if (!ctx.has('state.session.get')) {
      ctx.log('warn', '缺少 state.session.get，无法定位回执目标')
      return
    }
    const session = await ctx.call<Session | null>('state.session.get', { sessionId: p.sessionId })
    if (!session) return
    // 只回由本场景项目创建的会话；别人窗口的结束事件不碰。
    if (session.workspace !== cfg.project) return
    // 非钉钉来源的会话不能走钉钉回执；旧行没有 source 时保留原行为。
    if (session.source && !session.source.startsWith('source-dingtalk')) {
      ctx.log('info', `会话 ${session.id} 来源 ${session.source}，跳过钉钉回执`)
      return
    }
    if (!session.ownerId || !session.rootMessageId) {
      ctx.log('warn', `会话 ${session.id} 缺 ownerId/rootMessageId，无法回执`)
      return
    }
    if (!ctx.has('transport.dingtalk.send')) {
      ctx.log('warn', '缺少 transport.dingtalk.send，跳过回执')
      return
    }
    const summary =
      (p.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, cfg.replyMaxChars) || '已完成'
    const text = cfg.replyTemplate.replace('{{summary}}', summary)
    const r = await ctx.submit(
      'transport.dingtalk.send',
      {
        target: {
          openDingtalkId: session.ownerId,
          messageId: session.rootMessageId,
          conversationId: session.chatId,
        },
        text,
      },
      `turn:${session.id}`,
      { eventId: session.rootMessageId },
    )
    ctx.log('info', `回执 ${session.id} → receipt=${r.receiptId} status=${r.status}`)
  })
}
