/** 分析推送场景（P4b 最小片）：`#日报` 按时间窗汇总事件，不调模型、不写库。 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event } from '../../domain/types.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-digest',
  roles: ['scenario'],
  wants: ['event.query', 'notify.reply'],
  on: ['message.received'],
  config: z
    .object({
      commands: z.array(z.string()).default(['#日报']),
      windowHours: z.number().positive().default(24),
    })
    .strict(),
}

interface Row {
  kind: string
}

export function summarize(rows: Row[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
  if (counts.size === 0) return '这个时间窗没有事件。'
  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${kind} ${n}`)
  return `近窗事件 ${rows.length} 条：\n${lines.join('\n')}`
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as { commands: string[]; windowHours: number }

  ctx.on('message.received', async (e) => {
    const event = e.payload as Event
    if (!cfg.commands.includes(event.text.trim())) return
    if (!ctx.has('event.query') || !ctx.has('notify.reply')) return
    const to = new Date().toISOString()
    const from = new Date(Date.now() - cfg.windowHours * 3600_000).toISOString()
    const rows = await ctx.call<Row[]>('event.query', { from, to, limit: 1000 })
    const r = await ctx.submit(
      'notify.reply',
      {
        target: { channel: 'feishu', chatId: event.channel.id, messageId: event.rootId ?? event.externalId },
        text: summarize(rows),
      },
      `digest:${event.id}`,
    )
    ctx.log('info', `#日报 receipt=${r.receiptId} status=${r.status}`)
  })
}
