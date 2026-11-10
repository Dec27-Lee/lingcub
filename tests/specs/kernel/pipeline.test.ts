import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Channel, Classifier, Executor } from '../../../src/domain/ports.ts'
import type { Event, Intent, Progress, Work } from '../../../src/domain/types.ts'
import type { Config, Projects, Workspace } from '../../../src/kernel/config.ts'
import { eventId } from '../../../src/kernel/ids.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver, Pipeline } from '../../../src/kernel/pipeline.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const EMPTY_RULES: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
const silent = (): void => {}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'personal-lingcub',
    name: '个人 · 幺幺零',
    kind: 'repo',
    root: 'E:\\Develop_E\\lingcub',
    executor: 'dsh',
    isolation: 'worktree',
    concurrency: 1,
    freshSession: true,
    aliases: ['lingcub', '幺幺零'],
    ...over,
  }
}

function projects(): Projects {
  return { workspaces: [workspace()] }
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    mode: 'auto',
    log: { level: 'info' },
    store: { path: ':memory:' },
    sources: {},
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_test' } },
    classifiers: { llm: { plugin: 'classifier-llm', prompt: 'prompts/classify.md', minConfidence: 0.3 } },
    executor_policies: { dsh: { plugin: 'executor-dsh', allowRoots: ['E:\\Develop_E'] } },
    limits: { maxConcurrentSessions: 2, maxSessionMB: 80 },
    ...over,
  }
}

function ev(externalId = 'om_1'): Event {
  return {
    id: eventId('source-feishu-im', externalId),
    source: 'source-feishu-im',
    externalId,
    receivedAt: '2026-11-03T09:00:00.000Z',
    occurredAt: '2026-11-03T08:59:00.000Z',
    actor: { id: 'ou_1' },
    channel: { kind: 'group', id: 'oc_1' },
    text: '登录页点导出报错 500',
    raw: {},
  }
}

function intent(over: Partial<Intent> = {}): Intent {
  return {
    eventId: ev().id,
    kind: 'bug',
    topic: '导出报错 500',
    project: 'personal-lingcub',
    suggestedAction: 'dispatch_session',
    rationale: '给了具体故障现象',
    confidence: 0.9,
    ...over,
  }
}

/** 三假端口：假分类器、假执行器、假频道。全程不起进程、不触网。 */
function fakeEnv(verdict: Intent | null, readProgress?: Progress[]) {
  const started: Work[] = []
  const sent: { text: string; key: string }[] = []
  let readCalls = 0
  let finish = false

  const executor: Executor = {
    async start(w) {
      started.push(w)
      finish = true
      return { executor: 'dsh', sessionId: `s-${w.id}`, workspace: w.workspace }
    },
    async read(): Promise<Progress[]> {
      readCalls++
      if (readProgress) return readProgress
      return finish ? [{ at: '2026-11-03T09:10:00.000Z', kind: 'finished', text: '已完成：加了导出按钮' }] : []
    },
    async stop() {},
  }
  const channel: Channel = {
    async send(a, key) {
      sent.push({ text: a.kind === 'reply_only' ? a.text : a.kind, key })
      return { status: 'sent' }
    },
  }
  const classifier: Classifier = {
    async classify() {
      return verdict
    },
  }
  const ports: Ports = {
    sources: new Map(),
    classifiers: new Map([['classifier-llm', classifier]]),
    executors: new Map([['executor-dsh', executor]]),
    channels: new Map([['channel-feishu', channel]]),
  }
  return { ports, started, sent, readCalls: () => readCalls }
}

function build(verdict: Intent | null, config: Config = cfg(), withClassifier = true, readProgress?: Progress[]) {
  const store = openStore(':memory:')
  const env = fakeEnv(verdict, readProgress)
  const appended: unknown[] = []
  const eventLog = { append: (e: unknown) => appended.push(e) } as never
  const outbox = new Outbox(store, createDeliver({ ports: env.ports, config, projects: projects(), store, log: silent }))
  const pipeline = new Pipeline({
    store,
    outbox,
    eventLog,
    config,
    projects: projects(),
    rules: EMPTY_RULES,
    ports: env.ports,
    sessions: store,
    classifier: withClassifier ? { impl: env.ports.classifiers.get('classifier-llm')!, minConfidence: config.classifiers.llm?.minConfidence ?? 0.3 } : undefined,
    log: silent,
  })
  return { store, outbox, pipeline, appended, ...env }
}

test('假端到端：Event → 假分类器 → 假执行器开工 → 收到回执（不触网）', async () => {
  const { store, outbox, pipeline, started, sent } = build(intent())
  try {
    assert.equal(await pipeline.ingest(ev()), 'queued')
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.equal(started.length, 1)
    assert.equal(started[0]?.workspace, 'E:\\Develop_E\\lingcub')
    assert.equal(store.listWorksByStatus('running').length, 1)
    assert.equal(sent.length, 0, '任务还没收敛，不该发回执')

    assert.equal(await pipeline.collect(), 1)
    assert.equal(store.listWorksByStatus('running').length, 0)
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.equal(sent.length, 1)
    assert.match(sent[0]!.text, /加了导出按钮/)
  } finally {
    store.close()
  }
})

test('同一条消息重复投递只落一次库（不重复开工）', async () => {
  const { store, outbox, pipeline, started } = build(intent())
  try {
    assert.equal(await pipeline.ingest(ev()), 'queued')
    assert.equal(await pipeline.ingest(ev()), 'duplicate')
    assert.equal(store.countEvents(), 1)
    await outbox.tick()
    assert.equal(started.length, 1)
  } finally {
    store.close()
  }
})

test('observe 档只记录：不派工、不起会话', async () => {
  const { store, outbox, pipeline, started, sent } = build(intent(), cfg({ mode: 'observe' }))
  try {
    assert.equal(await pipeline.ingest(ev()), 'observed')
    await outbox.tick()
    assert.equal(started.length, 0)
    assert.equal(sent.length, 0)
    assert.equal(store.getIntent(ev().id)?.kind, 'bug')
    assert.equal(store.listWorksByStatus('queued').length, 0)
  } finally {
    store.close()
  }
})

test('suggest 档只发建议，不起会话', async () => {
  const { store, outbox, pipeline, started, sent } = build(intent(), cfg({ mode: 'suggest' }))
  try {
    assert.equal(await pipeline.ingest(ev()), 'queued')
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.equal(started.length, 0)
    assert.equal(sent.length, 1)
    assert.match(sent[0]!.text, /建议派工/)
  } finally {
    store.close()
  }
})

test('没有分类器且规则未命中：只记录，不派工', async () => {
  const { store, pipeline, started } = build(null, cfg(), false)
  try {
    assert.equal(await pipeline.ingest(ev()), 'ignored')
    assert.equal(store.countEvents(), 1)
    assert.equal(started.length, 0)
  } finally {
    store.close()
  }
})

test('置信度低于门槛：判断落库但只记录，不派工', async () => {
  const { store, pipeline, started } = build(intent({ confidence: 0.2 }), cfg())
  try {
    assert.equal(await pipeline.ingest(ev()), 'ignored')
    assert.equal(store.getIntent(ev().id)?.confidence, 0.2, '低置信度判断仍要留档给回放')
    assert.equal(started.length, 0)
  } finally {
    store.close()
  }
})

test('工作区不在允许根内：投递失败并重试，不静默吞掉', async () => {
  const { store, outbox, pipeline } = build(intent(), cfg({
    executor_policies: { dsh: { plugin: 'executor-dsh', allowRoots: ['E:\\Other'] } },
  }))
  try {
    // 路由层先拦：resolve 抛错 → ingest 直接失败，不入队
    await assert.rejects(() => pipeline.ingest(ev()), /不在允许根内/)
    assert.equal(store.listWorksByStatus('queued').length, 0)
    assert.equal(store.countOutbox('pending'), 0)
    await outbox.tick()
  } finally {
    store.close()
  }
})

test('status 命令交给场景时 Pipeline 不再处理', async () => {
  const { store, pipeline } = build(null, cfg({ control: { status: 'scenario' } }))
  try {
    const t = '2026-11-03T09:00:00.000Z'
    store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'dsh',
      workspace: 'personal-lingcub',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    const e = { ...ev('om_status'), text: '#status', threadId: 'th_1' }
    assert.equal(await pipeline.ingest(e), 'ignored')
    assert.equal(store.countOutbox('pending'), 0)
  } finally {
    store.close()
  }
})

test('stop 命令交给场景时 Pipeline 不再处理', async () => {
  const { store, pipeline } = build(null, cfg({ control: { stop: 'scenario' } }))
  try {
    const t = '2026-11-03T09:00:00.000Z'
    store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'dsh',
      workspace: 'personal-lingcub',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    assert.equal(await pipeline.ingest({ ...ev('om_stop'), text: '#stop', threadId: 'th_1' }), 'ignored')
    assert.equal(store.countOutbox('pending'), 0)
  } finally {
    store.close()
  }
})

test('new 命令交给场景时 Pipeline 不再处理', async () => {
  const { store, pipeline } = build(null, cfg({ control: { new: 'scenario' } }))
  try {
    const t = '2026-11-03T09:00:00.000Z'
    store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'dsh',
      workspace: 'personal-lingcub',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    assert.equal(await pipeline.ingest({ ...ev('om_new'), text: '#new', threadId: 'th_1' }), 'ignored')
    assert.equal(store.countOutbox('pending'), 0)
  } finally {
    store.close()
  }
})

test('消息总开关：bus 模式旧 Pipeline 只落库不路由', async () => {
  const { store, pipeline } = build(
    intent(),
    cfg({ control: { status: 'pipeline', stop: 'pipeline', new: 'pipeline', messages: 'bus' } }),
  )
  try {
    const e = ev()
    assert.equal(await pipeline.ingest(e), 'ignored')
    assert.ok(store.getEvent(e.id))
    assert.equal(store.countOutbox('pending'), 0)
  } finally {
    store.close()
  }
})

test('collect：event 开窗的 Work 不由旧 Pipeline 轮询', async () => {
  const { store, pipeline, started, readCalls } = build(null)
  try {
    const e = ev('om_event_open')
    store.insertEvent(e)
    store.insertIntent(intent({ eventId: e.id }))
    store.insertWork({
      id: 'w-event',
      intentId: e.id,
      kind: 'session',
      via: 'event',
      project: 'personal-lingcub',
      executor: 'dsh',
      workspace: 'E:\\Develop_E\\lingcub',
      prompt: 'event path',
      sessionId: 'exec-event',
      status: 'running',
    })
    assert.equal(await pipeline.collect(), 0)
    assert.equal(store.getWork('w-event')?.status, 'running')
    assert.deepEqual(started, [])
    assert.equal(readCalls(), 0)
  } finally {
    store.close()
  }
})

test('collect：观测到进度时发 session.progress 事件', async () => {
  const readProgress: Progress[] = [{ at: '2026-11-03T09:11:00.000Z', kind: 'output', text: '正在改导出按钮' }]
  const { store, pipeline, appended } = build(null, cfg(), true, readProgress)
  try {
    const e = ev('om_progress')
    store.insertEvent(e)
    store.insertIntent(intent({ eventId: e.id }))
    store.insertWork({
      id: 'w-progress',
      intentId: e.id,
      kind: 'session',
      project: 'personal-lingcub',
      executor: 'dsh',
      workspace: 'E:\\Develop_E\\lingcub',
      prompt: 'progress',
      sessionId: 'exec-progress',
      status: 'running',
    })
    await pipeline.collect()
    const progressEvents = appended.filter(
      (x) => typeof x === 'object' && x !== null && (x as { kind?: string }).kind === 'session.progress',
    )
    assert.equal(progressEvents.length, 1)
  } finally {
    store.close()
  }
})

test('resume/newwin/attach 交给场景时 Pipeline 不再处理', async () => {
  const { store, pipeline } = build(
    null,
    cfg({ control: { status: 'scenario', new: 'scenario' } }),
  )
  try {
    const t = '2026-11-03T09:00:00.000Z'
    store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'dsh',
      workspace: 'personal-lingcub',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    for (const [id, text] of [
      ['om_resume', '#resume'],
      ['om_newwin', '#新窗'],
      ['om_attach', '#attach'],
    ] as const) {
      assert.equal(await pipeline.ingest({ ...ev(id), text, threadId: 'th_1' }), 'ignored')
    }
    assert.equal(store.countOutbox('pending'), 0)
  } finally {
    store.close()
  }
})
