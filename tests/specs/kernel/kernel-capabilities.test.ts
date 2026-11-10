import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema } from '../../../src/kernel/config.ts'
import { registerKernelCapabilities } from '../../../src/kernel/kernel-capabilities.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Executor, Classifier } from '../../../src/domain/ports.ts'
import type { Event, Intent } from '../../../src/domain/types.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const silent = (): void => {}
const event: Event = {
  id: 'e1',
  source: 'feishu',
  externalId: 'om_1',
  receivedAt: '2026-11-04T00:00:00Z',
  occurredAt: '2026-11-04T00:00:00Z',
  actor: { id: 'u1' },
  channel: { kind: 'dm', id: 'c1' },
  text: '这个接口报错了',
  raw: {},
}

function setup(opts: { rules?: Ruleset; classifier?: { impl: Classifier; minConfidence: number } } = {}) {
  const store = openStore(':memory:')
  const config = ConfigSchema.parse({
    store: { path: ':memory:' },
    executor_policies: { claude: { plugin: 'executor-claude' }, dsh: { plugin: 'executor-dsh' } },
  })
  const rules: Ruleset = opts.rules ?? {
    rules: [{ id: 'r1', when: { always: true }, then: { kind: 'bug', confidence: 0.9, topic: '规则主题' } }],
    allowlist: { groups: [], people: [], keywords: [] },
  }
  const ports = {
    sources: new Map(),
    channels: new Map(),
    classifiers: new Map(),
    executors: new Map<string, Executor>([
      [
        'executor-claude',
        {
          listWorkspaces: async () => [{ root: 'b', label: 'B', lastActive: 1 }],
          listLiveSessions: async () => [
            { sessionId: 'live-1', cwd: 'E:\\ws', title: '导出', lastActive: 10, userTurns: 2, running: true },
          ],
          listSessions: async () => [
            { sessionId: 'old-1', cwd: 'E:\\ws', title: '旧会话', lastActive: 5, userTurns: 1, running: false },
          ],
        } as unknown as Executor,
      ],
      [
        'executor-dsh',
        {
          listWorkspaces: async () => [
            { root: 'a', label: 'A', lastActive: 2 },
            { root: 'b', label: 'B', lastActive: 3 },
          ],
        } as unknown as Executor,
      ],
    ]),
    docs: new Map([
      [
        'capability-doc-memory',
        {
          read: async () => ({ revision: 'r1', markdown: '# 文档\n' }),
          write: async () => ({ revision: 'r2' }),
        },
      ],
    ]),
  } as unknown as Ports
  const capabilities = new Capabilities(store, { log: silent })
  registerKernelCapabilities({
    capabilities,
    config,
    projects: {
      workspaces: [
        {
          id: 'proj',
          name: 'Proj',
          kind: 'repo',
          root: 'E:\\ws\\proj',
          executor: 'claude',
          isolation: 'session',
          concurrency: 1,
          freshSession: true,
          aliases: [],
        },
      ],
    },
    rules,
    classifier: opts.classifier,
    ports,
    store,
    log: silent,
  })
  return { store, capabilities }
}

test('judge.classify：规则优先，命中即返回 Intent', async () => {
  const s = setup()
  try {
    const intent = await s.capabilities.call<Intent | null>('judge.classify', { event }, { caller: 't' })
    assert.ok(intent)
    assert.equal(intent.byRule, 'r1')
    assert.equal(intent.topic, '规则主题')
    assert.equal(intent.confidence, 0.9)
  } finally {
    s.store.close()
  }
})

test('judge.classify：规则不中走分类器，低置信度返回 null', async () => {
  const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
  const impl: Classifier = {
    async classify() {
      return {
        eventId: 'e1',
        kind: 'question',
        topic: '模型主题',
        suggestedAction: 'reply_only',
        rationale: '模型判断',
        confidence: 0.5,
      }
    },
  }
  const low = setup({ rules, classifier: { impl, minConfidence: 0.6 } })
  try {
    assert.equal(await low.capabilities.call('judge.classify', { event }, { caller: 't' }), null)
  } finally {
    low.store.close()
  }
  const high = setup({ rules, classifier: { impl, minConfidence: 0.4 } })
  try {
    const intent = await high.capabilities.call<Intent | null>('judge.classify', { event }, { caller: 't' })
    assert.equal(intent?.topic, '模型主题')
  } finally {
    high.store.close()
  }
})

test('workspace.list：合并两个执行器、按 root 去重、按最近活跃排序，可按执行器过滤', async () => {
  const s = setup()
  try {
    const all = await s.capabilities.call<{ root: string; label: string }[]>('workspace.list', {}, { caller: 't' })
    assert.deepEqual(
      all.map((w) => w.root),
      ['a', 'b'],
    )
    assert.equal(all.find((w) => w.root === 'b')?.label, 'B')

    const onlyClaude = await s.capabilities.call<{ root: string }[]>(
      'workspace.list',
      { executor: 'claude' },
      { caller: 't' },
    )
    assert.deepEqual(
      onlyClaude.map((w) => w.root),
      ['b'],
    )
  } finally {
    s.store.close()
  }
})

test('state.session.route：按话题找会话，dead/未绑定返回 null', async () => {
  const s = setup()
  const t = '2026-11-04T00:00:00Z'
  try {
    s.store.insertSession({
      id: 's1',
      chatId: 'oc1',
      threadId: 'th1',
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    const ok = await s.capabilities.call<{ id: string } | null>(
      'state.session.route',
      { chatId: 'oc1', threadId: 'th1' },
      { caller: 't' },
    )
    assert.equal(ok?.id, 's1')

    s.store.setSessionStatus('s1', 'dead')
    assert.equal(
      await s.capabilities.call('state.session.route', { chatId: 'oc1', threadId: 'th1' }, { caller: 't' }),
      null,
    )
    assert.equal(
      await s.capabilities.call('state.session.route', { chatId: 'oc1', threadId: 'nope' }, { caller: 't' }),
      null,
    )
  } finally {
    s.store.close()
  }
})

test('event.query：按时间窗与 kind 过滤', async () => {
  const s = setup()
  try {
    const t = '2026-11-04T00:00:00Z'
    s.store.appendEventLog({ id: 'e1', kind: 'message.received', source: 'x', at: '2026-11-03T00:00:00Z', payload: { a: 1 } })
    s.store.appendEventLog({ id: 'e2', kind: 'effect.done', source: 'kernel', at: t, payload: { b: 2 } })
    const all = await s.capabilities.call<{ id: string }[]>(
      'event.query',
      { from: '2026-11-03T00:00:00Z', to: '2026-11-05T00:00:00Z' },
      { caller: 't' },
    )
    assert.equal(all.length, 2)
    const only = await s.capabilities.call<{ id: string }[]>(
      'event.query',
      { from: t, to: '2026-11-05T00:00:00Z', kinds: ['effect.done'] },
      { caller: 't' },
    )
    assert.deepEqual(only.map((r) => r.id), ['e2'])
  } finally {
    s.store.close()
  }
})

test('event.query：只按时间窗过滤（不靠 kind 掩盖）', async () => {
  const s = setup()
  try {
    s.store.appendEventLog({ id: 'e1', kind: 'message.received', source: 'x', at: '2026-11-03T00:00:00Z', payload: {} })
    s.store.appendEventLog({ id: 'e2', kind: 'effect.done', source: 'kernel', at: '2026-11-04T00:00:00Z', payload: {} })
    const rows = await s.capabilities.call<{ id: string }[]>(
      'event.query',
      { from: '2026-11-04T00:00:00Z', to: '2026-11-05T00:00:00Z' },
      { caller: 't' },
    )
    assert.deepEqual(rows.map((r) => r.id), ['e2'])
  } finally {
    s.store.close()
  }
})

test('state.question.get：有则返回，无则 null', async () => {
  const s = setup()
  try {
    const t = '2026-11-04T00:00:00Z'
    s.store.insertQuestion({ id: 'q1', sessionId: 's1', questions: [{ q: '选哪个' }], createdAt: t, expiresAt: t })
    const q = await s.capabilities.call<{ id: string; questions: unknown } | null>(
      'state.question.get',
      { id: 'q1' },
      { caller: 't' },
    )
    assert.equal(q?.id, 'q1')
    assert.deepEqual(q?.questions, [{ q: '选哪个' }])
    assert.equal(await s.capabilities.call('state.question.get', { id: 'nope' }, { caller: 't' }), null)
  } finally {
    s.store.close()
  }
})

test('state.workstation.snapshot：汇总会话/工作/发件箱计数', async () => {
  const s = setup()
  try {
    const t = '2026-11-04T00:00:00Z'
    s.store.insertSession({
      id: 's1',
      chatId: 'oc1',
      threadId: 'th1',
      executor: 'dsh',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    const snap = await s.capabilities.call<{
      sessions: Record<string, number>
      works: Record<string, number>
      outbox: Record<string, number>
    }>('state.workstation.snapshot', {}, { caller: 't' })
    assert.equal(snap.sessions.active, 1)
    assert.equal(snap.outbox.pending, 0)
  } finally {
    s.store.close()
  }
})


test('state.session.list：按 chat 列历史会话，limit 生效', async () => {
  const s = setup()
  try {
    s.store.insertSession({
      id: 's1',
      chatId: 'c1',
      title: '导出',
      executor: 'claude',
      workspace: 'w',
      status: 'stopped',
      createdAt: '2026-11-04T00:00:00Z',
      lastActiveAt: '2026-11-04T00:00:00Z',
    })
    const rows = await s.capabilities.call<{ id: string }[]>('state.session.list', { chatId: 'c1' }, { caller: 't' })
    assert.deepEqual(rows.map((r) => r.id), ['s1'])
    assert.equal((await s.capabilities.call('state.session.list', { chatId: 'other' }, { caller: 't' })).length, 0)
  } finally {
    s.store.close()
  }
})

test('state.session.live：聚合执行器活会话，不支持时为空', async () => {
  const s = setup()
  try {
    const live = await s.capabilities.call<{ executor: string; sessionId: string }[]>(
      'state.session.live',
      {},
      { caller: 't' },
    )
    assert.deepEqual(live, [
      { executor: 'claude', sessionId: 'live-1', cwd: 'E:\\ws', title: '导出', lastActive: 10, userTurns: 2, running: true },
    ])
    assert.deepEqual(await s.capabilities.call('state.session.live', { executor: 'dsh' }, { caller: 't' }), [])
  } finally {
    s.store.close()
  }
})

test('state.session.history：聚合执行器历史会话，按 cwd/executor 过滤', async () => {
  const s = setup()
  try {
    const all = await s.capabilities.call<{ sessionId: string }[]>('state.session.history', {}, { caller: 't' })
    assert.deepEqual(all.map((x) => x.sessionId), ['old-1'])
    assert.deepEqual(
      await s.capabilities.call('state.session.history', { cwd: 'E:\\other' }, { caller: 't' }),
      [],
    )
    assert.deepEqual(
      await s.capabilities.call('state.session.history', { executor: 'dsh' }, { caller: 't' }),
      [],
    )
  } finally {
    s.store.close()
  }
})

test('state.workspace.get：项目 id 换根路径，未知返回 null', async () => {
  const s = setup()
  try {
    const w = await s.capabilities.call<{ root: string; executor: string } | null>(
      'state.workspace.get',
      { id: 'proj' },
      { caller: 't' },
    )
    assert.equal(w?.root, 'E:\\ws\\proj')
    assert.equal(w?.executor, 'claude')
    assert.equal(await s.capabilities.call('state.workspace.get', { id: 'nope' }, { caller: 't' }), null)
  } finally {
    s.store.close()
  }
})

test('doc.read：经 DocPort 返回 revision 与正文', async () => {
  const s = setup()
  try {
    const r = await s.capabilities.call<{ revision: string; markdown: string }>(
      'state.doc.snapshot',
      { doc: 'd1' },
      { caller: 't' },
    )
    assert.equal(r.revision, 'r1')
    assert.match(r.markdown, /文档/)
  } finally {
    s.store.close()
  }
})

test('state.history.fetch：没有 source 历史时退回事件库，按 before 排除当前消息', async () => {
  const s = setup()
  try {
    s.store.insertEvent({
      ...event,
      id: 'old',
      externalId: 'm-old',
      receivedAt: '2026-11-04T00:01:00Z',
      text: '旧消息',
    })
    s.store.insertEvent({
      ...event,
      id: 'cur',
      externalId: 'm-cur',
      receivedAt: '2026-11-04T00:02:00Z',
      text: '当前消息',
    })
    const r = await s.capabilities.call<{
      items: { externalId: string; text: string }[]
      complete: boolean
      via: string
    }>(
      'state.history.fetch',
      { source: 'source-x', channelId: 'c1', before: '2026-11-04T00:02:00Z', limit: 10 },
      { caller: 't' },
    )
    assert.equal(r.via, 'event-store')
    assert.equal(r.complete, false)
    assert.deepEqual(r.items.map((i) => i.externalId), ['m-old'])
  } finally {
    s.store.close()
  }
})

test('state.analysis.pending：只返回还没有 analysis 事件的消息', async () => {
  const s = setup()
  try {
    s.store.insertEvent({
      ...event,
      id: 'pending',
      externalId: 'm-pending',
      receivedAt: new Date().toISOString(),
      text: '待分析',
    })
    const rows = await s.capabilities.call<{ id: string }[]>(
      'state.analysis.pending',
      { limit: 10, sinceMinutes: 60 },
      { caller: 't' },
    )
    assert.ok(rows.some((r) => r.id === 'pending'))
  } finally {
    s.store.close()
  }
})
