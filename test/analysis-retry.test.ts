import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as analysis from '../src/plugins/scenario-analysis/index.ts'
import type { PluginContextV2 } from '../src/domain/plugin-v2.ts'
import type { Event } from '../src/domain/types.ts'

const event: Event = {
  id: 'ev-retry',
  source: 'source-dingtalk',
  externalId: 'm-retry',
  receivedAt: '2026-11-05T09:00:00.000Z',
  occurredAt: '2026-11-05T09:00:00.000Z',
  actor: { id: 'u1', name: '李健生' },
  channel: { kind: 'dm', id: 'c1', name: '李健生' },
  text: '这个怎么处理？',
  raw: {},
}

test('分析降级后补扫重试：attempt=1 degraded，attempt=2 ok', async () => {
  const handlers = new Map<string, (e: { payload: unknown }) => void>()
  const emitted: { payload: { event: Event; analysis: { status: string; attempt?: number } }; id?: string }[] = []
  let modelCalls = 0
  const ctx = {
    config: {
      historyLimit: 5,
      maxInFlight: 1,
      sweepIntervalMs: 50,
      sweepLimit: 5,
      sweepLookbackMinutes: 10,
      retryDegraded: true,
      maxAttempts: 2,
      sources: [],
    },
    log: () => {},
    has: () => true,
    on: (kind: string, handler: (e: { payload: unknown }) => void) => handlers.set(kind, handler),
    emit: (kind: string, payload: unknown, opts?: { id?: string }) => {
      if (kind === 'message.analyzed') {
        emitted.push({ payload: payload as (typeof emitted)[number]['payload'], id: opts?.id })
      }
    },
    call: async (name: string) => {
      if (name === 'state.history.fetch') return { items: [], complete: false, via: 'event-store' }
      if (name === 'state.analysis.pending') return []
      if (name === 'state.analysis.degraded') {
        const latest = emitted.at(-1)?.payload.analysis
        return latest?.status === 'degraded'
          ? [{ event, analysis: latest, analysisEventId: 'analysis:ev-retry' }]
          : []
      }
      if (name === 'ai.summarize') {
        modelCalls++
        if (modelCalls === 1) throw new Error('模型暂时不可用')
        return { summary: '已恢复', model: 'fake' }
      }
      throw new Error(`未模拟能力：${name}`)
    },
  } as unknown as PluginContextV2

  analysis.setup(ctx)
  try {
    handlers.get('message.received')?.({ payload: event })
    await new Promise((resolve) => setTimeout(resolve, 2400))
    assert.equal(emitted.length, 2)
    assert.equal(emitted[0]?.payload.analysis.attempt, 1)
    assert.equal(emitted[0]?.payload.analysis.status, 'degraded')
    assert.equal(emitted[1]?.payload.analysis.attempt, 2)
    assert.equal(emitted[1]?.payload.analysis.status, 'ok')
    assert.equal(emitted[1]?.id, 'analysis:ev-retry:r1')
  } finally {
    await analysis.stop(ctx)
  }
})
