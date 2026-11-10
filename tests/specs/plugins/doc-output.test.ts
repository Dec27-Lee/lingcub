import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as docOutput from '../../../src/plugins/scenario-doc-output/index.ts'
import type { PluginContextV2 } from '../../../src/domain/plugin-v2.ts'

test('文档出口：doc target 命中时按快照 revision 提交 doc.write', async () => {
  const handlers = new Map<string, (e: { id: string; payload: unknown }) => Promise<void>>()
  const submitted: { name: string; input: Record<string, unknown>; opKey: string }[] = []
  const ctx = {
    config: { target: 'doc', doc: 'doccn123', heading: '消息摘要' },
    log: () => {},
    has: () => true,
    on: (kind: string, handler: (e: { id: string; payload: unknown }) => Promise<void>) =>
      handlers.set(kind, handler),
    call: async () => ({ revision: 'rev-1', markdown: '# 文档' }),
    submit: async (name: string, input: Record<string, unknown>, opKey: string) => {
      submitted.push({ name, input, opKey })
      return { receiptId: 1, duplicate: false, status: 'submitted' as const }
    },
  } as unknown as PluginContextV2

  docOutput.setup(ctx)
  await handlers.get('distribution.decided')?.({
    id: 'dist-1',
    payload: {
      event: { id: 'ev-1', channel: { id: 'c1' } },
      analysis: { status: 'ok', origin: 'live', summary: '要处理的摘要' },
      decision: { targets: ['doc'] },
    },
  })
  assert.equal(submitted[0]?.name, 'doc.write')
  assert.equal(submitted[0]?.input.revision, 'rev-1')
  assert.equal(submitted[0]?.input.heading, '消息摘要')
  assert.equal(submitted[0]?.input.body, '要处理的摘要')
  assert.equal(submitted[0]?.opKey, 'doc:ev-1')
})

test('文档出口：backfill 不写文档', async () => {
  let called = 0
  const handlers = new Map<string, (e: { id: string; payload: unknown }) => Promise<void>>()
  const ctx = {
    config: { target: 'doc', doc: 'doccn123', heading: '消息摘要' },
    log: () => {},
    has: () => true,
    on: (kind: string, handler: (e: { id: string; payload: unknown }) => Promise<void>) =>
      handlers.set(kind, handler),
    call: async () => {
      called++
      return { revision: 'r', markdown: '' }
    },
    submit: async () => {
      called++
      return { receiptId: 1, duplicate: false, status: 'submitted' as const }
    },
  } as unknown as PluginContextV2
  docOutput.setup(ctx)
  await handlers.get('distribution.decided')?.({
    id: 'dist-2',
    payload: {
      event: { id: 'ev-2', channel: { id: 'c1' } },
      analysis: { status: 'ok', origin: 'backfill', summary: '旧' },
      decision: { targets: ['doc'] },
    },
  })
  assert.equal(called, 0)
})
