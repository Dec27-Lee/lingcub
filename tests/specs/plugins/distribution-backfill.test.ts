import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as distribution from '../../../src/plugins/scenario-distribution/index.ts'
import type { PluginContextV2 } from '../../../src/domain/plugin-v2.ts'
import type { Event } from '../../../src/domain/types.ts'

const event: Event = {
  id: 'ev-bf',
  source: 'source-dingtalk',
  externalId: 'm-bf',
  receivedAt: '2026-11-05T09:00:00.000Z',
  occurredAt: '2026-11-05T09:00:00.000Z',
  actor: { id: 'u1' },
  channel: { kind: 'dm', id: 'c1' },
  text: '历史消息',
  raw: {},
}

test('backfill 分析不触发任何分发出口', () => {
  const handlers = new Map<string, (e: { id: string; payload: unknown }) => void>()
  const emitted: { payload: { analysis: { origin?: string }; decision: { targets: string[] } } }[] = []
  const ctx = {
    config: { rules: [{ id: 'all', when: {}, targets: ['feishu-card'] }] },
    log: () => {},
    on: (kind: string, handler: (e: { id: string; payload: unknown }) => void) =>
      handlers.set(kind, handler),
    emit: (kind: string, payload: unknown) => {
      if (kind === 'distribution.decided') {
        emitted.push({ payload: payload as (typeof emitted)[number]['payload'] })
      }
    },
  } as unknown as PluginContextV2

  distribution.setup(ctx)
  handlers.get('message.analyzed')?.({
    id: 'analysis:ev-bf',
    payload: {
      event,
      analysis: { eventId: event.id, summary: '历史', status: 'ok', contextCount: 0, origin: 'backfill' },
    },
  })
  assert.equal(emitted.length, 1)
  assert.deepEqual(emitted[0]?.payload.decision.targets, [])
})
