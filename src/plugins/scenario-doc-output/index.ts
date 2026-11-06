/**
 * 文档出口：分发规则把 doc 放进 targets 时，把分析摘要写回指定飞书文档小节。
 * 默认不启用；doc/heading 必须由配置显式给出，避免误写。
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event, MessageAnalysis } from '../../domain/types.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-doc-output',
  roles: ['scenario'],
  on: ['distribution.decided'],
  wants: ['state.doc.snapshot', 'doc.write'],
  config: z
    .object({
      target: z.string().default('doc'),
      doc: z.string().default(''),
      heading: z.string().min(1).default('消息摘要'),
    })
    .strict(),
}

export function fingerprint(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex').slice(0, 16)
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as { target: string; doc: string; heading: string }
  ctx.on('distribution.decided', async (e) => {
    const p = e.payload as {
      event: Event
      analysis: MessageAnalysis
      decision: { targets: string[] }
    }
    if (!p.decision.targets.includes(cfg.target)) return
    if (!cfg.doc) return
    if (p.analysis.origin === 'backfill' || p.analysis.status !== 'ok') return
    if (!ctx.has('state.doc.snapshot') || !ctx.has('doc.write')) {
      ctx.log('warn', '缺少 state.doc.snapshot / doc.write，跳过文档出口')
      return
    }
    const snap = await ctx.call<{ revision: string; markdown: string }>('state.doc.snapshot', {
      doc: cfg.doc,
    })
    const r = await ctx.submit(
      'doc.write',
      {
        doc: cfg.doc,
        heading: cfg.heading,
        body: p.analysis.summary,
        revision: snap.revision,
        fingerprint: fingerprint(snap.markdown),
      },
      `doc:${p.event.id}`,
      { eventId: p.event.id },
    )
    ctx.log('info', `文档出口 ${p.event.id} → ${cfg.doc}/${cfg.heading} receipt=${r.receiptId}`)
  })
}
