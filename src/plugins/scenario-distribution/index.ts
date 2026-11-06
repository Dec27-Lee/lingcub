/**
 * 平台分发决策层：只按配置决定“这条已分析消息去哪些出口”。
 *
 * 规则是确定性的代码查表；模型给的 analysis 只是输入之一，不直接决定出口。
 * 出口消费者（飞书卡、任务、执行器、文档）只订阅 distribution.decided。
 */

import { z } from 'zod'
import { DISTRIBUTION_DECIDED } from '../../domain/events.ts'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event, MessageAnalysis } from '../../domain/types.ts'

const Rule = z
  .object({
    id: z.string().min(1),
    when: z
      .object({
        sources: z.array(z.string()).optional(),
        channelKinds: z.array(z.enum(['dm', 'group'])).optional(),
        urgency: z.array(z.enum(['low', 'normal', 'high'])).optional(),
      })
      .strict()
      .default({}),
    targets: z.array(z.string().min(1)).min(1),
  })
  .strict()

export type DistributionRule = z.infer<typeof Rule>

export function decideDistribution(
  rules: DistributionRule[],
  input: { source: string; channelKind: 'dm' | 'group'; urgency?: MessageAnalysis['urgency'] },
): { ruleId?: string; targets: string[] } {
  for (const rule of rules) {
    const w = rule.when
    if (w.sources && !w.sources.includes(input.source)) continue
    if (w.channelKinds && !w.channelKinds.includes(input.channelKind)) continue
    if (w.urgency && (!input.urgency || !w.urgency.includes(input.urgency))) continue
    return { ruleId: rule.id, targets: rule.targets }
  }
  return { targets: [] }
}

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-distribution',
  roles: ['scenario'],
  on: ['message.analyzed'],
  config: z.object({ rules: z.array(Rule).default([]) }).strict(),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as { rules: DistributionRule[] }
  ctx.on('message.analyzed', (e) => {
    const payload = e.payload as { event: Event; analysis: MessageAnalysis }
    const event = payload.event
    const analysis = payload.analysis
    const decision =
      analysis.origin === 'backfill'
        ? { targets: [] }
        : decideDistribution(cfg.rules, {
            source: event.source,
            channelKind: event.channel.kind === 'group' ? 'group' : 'dm',
            urgency: analysis.urgency,
          })
    ctx.emit(
      DISTRIBUTION_DECIDED,
      { event, analysis, decision },
      {
        id: `distribution:${event.id}:${analysis.attempt ?? 1}:${decision.ruleId ?? 'none'}`,
        subject: event.channel.id,
        causedBy: e.id,
      },
    )
    ctx.log(
      'info',
      `分发 ${event.id} rule=${decision.ruleId ?? (analysis.origin === 'backfill' ? 'backfill-suppressed' : 'none')} targets=${decision.targets.join(',') || 'none'}`,
    )
  })
}
