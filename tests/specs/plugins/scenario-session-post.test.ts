import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as post from '../../../src/plugins/scenario-session-post/index.ts'
import type { Event, Session } from '../../../src/domain/types.ts'

const silent = (): void => {}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    chatId: 'c1',
    threadId: 't1',
    executor: 'dsh',
    workspace: 'w',
    status: 'active',
    createdAt: '2026-11-04T00:00:00Z',
    lastActiveAt: '2026-11-04T00:00:00Z',
    ...over,
  }
}

function event(over: Partial<Event> = {}): Event {
  return {
    id: 'ev1',
    source: 'dingtalk',
    externalId: 'x1',
    receivedAt: '2026-11-04T00:00:00Z',
    occurredAt: '2026-11-04T00:00:00Z',
    actor: { id: 'u1' },
    channel: { kind: 'dm', id: 'c1' },
    text: '再补个测试',
    raw: {},
    ...over,
  }
}

function mount(routes: Record<string, Session | null>) {
  let handler: ((e: { payload: unknown }) => Promise<void>) | null = null
  const calls: { kind: string; name: string; input: unknown }[] = []
  post.setup({
    config: { sources: ['dingtalk'], skipPrefixes: ['#'] },
    has: () => true,
    on: (_kind: string, fn: never) => {
      handler = fn
    },
    call: async (name: string, input: unknown) => {
      calls.push({ kind: 'call', name, input })
      const thread = (input as { threadId?: string }).threadId ?? ''
      return routes[thread] ?? null
    },
    submit: async (name: string, input: unknown) => {
      calls.push({ kind: 'submit', name, input })
      return { receiptId: 1, status: 'submitted' }
    },
    log: silent,
  } as never)
  assert.ok(handler, '没有注册 message.received')
  return { run: (e: Event) => handler?.({ payload: e }), calls }
}

test('话题投递：按 thread 找到活会话就 session.post', async () => {
  const m = mount({ t1: session() })
  await m.run(event({ threadId: 't1' }))
  const submit = m.calls.find((c) => c.kind === 'submit')
  assert.deepEqual(submit?.input, { sessionId: 's1', text: '再补个测试' })
})

test('话题投递：thread 没有时按 root 回退', async () => {
  const m = mount({ r1: session() })
  await m.run(event({ threadId: 'missing', rootId: 'r1' }))
  assert.equal(m.calls.some((c) => c.kind === 'submit'), true)
})

test('话题投递：命令、停掉的会话、无会话都不投', async () => {
  const m = mount({ t1: session({ status: 'stopped' }) })
  await m.run(event({ threadId: 't1', text: '#status' }))
  await m.run(event({ threadId: 't1' }))
  await m.run(event({ threadId: 'other' }))
  assert.equal(m.calls.some((c) => c.kind === 'submit'), false)
})

test('话题投递：默认 sources 认的是真实 source id（source-feishu-im），不是渠道名', async () => {
  // 不传 sources → 用 schema 默认值
  let handler: ((e: { payload: unknown }) => Promise<void>) | null = null
  const submitted: unknown[] = []
  const manifestConfig = post.manifest.config.parse({})
  post.setup({
    config: manifestConfig,
    has: () => true,
    on: (_kind: string, fn: never) => {
      handler = fn
    },
    call: async () => session(),
    submit: async (_name: string, input: unknown) => {
      submitted.push(input)
      return { receiptId: 1, status: 'submitted' }
    },
    log: silent,
  } as never)
  await handler?.({ payload: event({ source: 'source-feishu-im', threadId: 't1' }) })
  assert.equal(submitted.length, 1, '默认配置下飞书消息应当投进窗口')
})
