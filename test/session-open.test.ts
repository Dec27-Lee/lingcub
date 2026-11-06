import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema } from '../src/kernel/config.ts'
import { createEffectRouter } from '../src/kernel/effect-router.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { createDeliver } from '../src/kernel/pipeline.ts'
import { createGate } from '../src/kernel/policy.ts'
import { openStore } from '../src/kernel/store.ts'
import { registerSessionOpenHandlers } from '../src/kernel/session-open.ts'
import { assembleV2 } from '../src/kernel/plugin-v2/index.ts'
import * as claudeV2 from '../src/plugins/executor-claude-v2/index.ts'
import type { SessionOpenRequest, Work } from '../src/domain/types.ts'
import type { Ports } from '../src/kernel/wiring.ts'

const silent = (): void => {}

const work: Work = {
  id: 'work-open-1',
  intentId: 'ev-1',
  kind: 'session',
  project: 'proj',
  executor: 'claude',
  workspace: 'E:\\ws\\proj',
  prompt: '修登录',
  status: 'queued',
  ownerId: 'u1',
  origin: { chatId: 'c1', threadId: 't1', rootMessageId: 'm1', title: '修登录' },
}

async function setup() {
  const store = openStore(':memory:')
  const config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\ws'] } },
  })
  const projects = {
    workspaces: [
      {
        id: 'proj',
        name: 'proj',
        kind: 'repo',
        root: 'E:\\ws\\proj',
        executor: 'claude',
        isolation: 'shared',
        concurrency: 1,
        freshSession: false,
        aliases: [],
      },
    ],
  }
  const ports = {
    sources: new Map(),
    classifiers: new Map(),
    executors: new Map(),
    channels: new Map(),
  } as unknown as Ports
  const eventLog = new EventLog(store, { log: silent })
  const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, eventLog, log: silent }), {
    log: silent,
  })
  const capabilities = new Capabilities(store, {
    log: silent,
    gate: createGate({ config, store, log: silent }),
    enqueue: createEffectRouter({ store, outbox, config, projects }),
  })
  registerKernelCapabilities({
    capabilities,
    config,
    projects,
    rules: { rules: [], allowlist: { groups: [], people: [], keywords: [] } },
    ports,
    store,
    log: silent,
  })
  registerSessionOpenHandlers({ store, eventLog, log: silent })
  store.insertEvent({
    id: 'ev-1',
    source: 'test',
    externalId: 'ev-1',
    receivedAt: '2026-11-05T00:00:00.000Z',
    occurredAt: '2026-11-05T00:00:00.000Z',
    actor: { id: 'u1' },
    channel: { kind: 'dm', id: 'c1' },
    text: '修登录',
    raw: {},
  })
  store.insertIntent({
    eventId: 'ev-1',
    kind: 'dev-request',
    topic: '修登录',
    project: 'proj',
    suggestedAction: 'dispatch_session',
    rationale: 'test',
    confidence: 1,
  })
  store.insertWork(work)
  return { store, eventLog, outbox, capabilities }
}

test('session.open：先落请求与事件，执行器 opened 后建会话并发 ready', async () => {
  const { store, eventLog, outbox, capabilities } = await setup()
  try {
    const ready: string[] = []
    eventLog.subscribe('witness', 'session.ready', (e) => {
      ready.push((e.payload as { requestId: string }).requestId)
    })
    eventLog.subscribe('fake-executor', 'session.open.requested', async (e) => {
      const req = e.payload as SessionOpenRequest
      assert.equal(req.work.id, work.id)
      eventLog.append({
        id: `opened:${req.requestId}`,
        kind: 'session.opened',
        source: 'fake-executor',
        subject: req.requestId,
        payload: { requestId: req.requestId, executor: 'claude', sessionId: 'claude-9', cwd: work.workspace },
      })
    })

    const r = await capabilities.submit('session.open', { work, mode: 'terminal' }, { caller: 'test', opKey: 'open:1' })
    assert.equal(r.status, 'submitted')

    await outbox.tick()
    assert.ok(store.getSessionOpen(work.id), 'open_session 动作执行后请求仍在')
    for (let i = 0; i < 3; i++) await eventLog.tick()

    const opened = store.getSessionOpen(work.id)
    assert.equal(opened?.status, 'opened')
    const session = store.getSession(`sess-${work.id}`)
    assert.equal(session?.sessionId, 'claude-9')
    // 存执行器真实 cwd（投递/停止要拿它当 cwd 用），不是工作区 id
    assert.equal(session?.workspace, 'E:\\ws\\proj')
    assert.equal(store.getWork(work.id)?.status, 'running')
    assert.deepEqual(ready, [work.id])
  } finally {
    store.close()
  }
})

test('session.open：执行器 failed 时工作项失败、请求保持 failed', async () => {
  const { store, eventLog, outbox, capabilities } = await setup()
  try {
    eventLog.subscribe('fake-executor', 'session.open.requested', (e) => {
      const req = e.payload as SessionOpenRequest
      eventLog.append({
        id: `failed:${req.requestId}`,
        kind: 'session.open.failed',
        source: 'fake-executor',
        subject: req.requestId,
        payload: { requestId: req.requestId, reason: 'boom' },
      })
    })
    await capabilities.submit('session.open', { work, mode: 'terminal' }, { caller: 'test', opKey: 'open:2' })
    await outbox.tick()
    for (let i = 0; i < 3; i++) await eventLog.tick()
    assert.equal(store.getSessionOpen(work.id)?.status, 'failed')
    assert.equal(store.getWork(work.id)?.status, 'failed')
    assert.equal(store.getSession(`sess-${work.id}`), null)
  } finally {
    store.close()
  }
})

test('task.open via=event：落 event Work 并生成 session.open.requested', async () => {
  const { store, eventLog, outbox, capabilities } = await setup()
  try {
    const r = await capabilities.submit(
      'task.open',
      {
        event: store.getEvent('ev-1'),
        intent: {
          eventId: 'ev-1',
          kind: 'dev-request',
          topic: '修登录',
          project: 'proj',
          suggestedAction: 'dispatch_session',
          rationale: 'test',
          confidence: 1,
        },
        dispatch: true,
        via: 'event',
        mode: 'headless',
      },
      { caller: 'test', opKey: 'task:event:1' },
    )
    assert.equal(r.status, 'submitted')
    await outbox.tick()
    const w = store.listWorksByStatus('queued').find((x) => x.id !== work.id)
    assert.ok(w)
    assert.equal(w?.via, 'event')
    assert.ok(store.getSessionOpen(w!.id))
  } finally {
    store.close()
  }
})

test('task.open via=event → 执行器 opened → session.ready 全链路', async () => {
  const { store, eventLog, outbox, capabilities } = await setup()
  try {
    eventLog.subscribe('fake-executor-event-open', 'session.open.requested', async (e) => {
      const req = e.payload as SessionOpenRequest
      eventLog.append({
        id: `opened:${req.requestId}`,
        kind: 'session.opened',
        source: 'fake-executor',
        subject: req.requestId,
        payload: { requestId: req.requestId, executor: 'claude', sessionId: 'claude-event-9', cwd: 'E:\\ws\\proj' },
      })
    })
    await capabilities.submit(
      'task.open',
      {
        event: store.getEvent('ev-1'),
        intent: {
          eventId: 'ev-1',
          kind: 'dev-request',
          topic: '修登录',
          project: 'proj',
          suggestedAction: 'dispatch_session',
          rationale: 'test',
          confidence: 1,
        },
        dispatch: true,
        via: 'event',
        mode: 'headless',
      },
      { caller: 'test', opKey: 'task:event:2' },
    )
    await outbox.tick()
    const w = store.listWorksByStatus('queued').find((x) => x.id !== work.id)
    assert.ok(w)
    for (let i = 0; i < 3; i++) await eventLog.tick()
    assert.equal(store.getSessionOpen(w!.id)?.status, 'opened')
    assert.equal(store.getSession(`sess-${w!.id}`)?.sessionId, 'claude-event-9')
    assert.equal(store.getWork(w!.id)?.status, 'running')
  } finally {
    store.close()
  }
})

test('executor-claude-v2：清单 v2 可装配并订阅 session.open.requested', async () => {
  const store = openStore(':memory:')
  try {
    const config = ConfigSchema.parse({
      store: { path: ':memory:' },
      plugins: {
        'claude-v2': {
          plugin: 'executor-claude-v2',
          enabled: true,
          allowRoots: ['E:\\ws'],
          terminal: false,
        },
      },
    })
    const eventLog = new EventLog(store, { log: silent })
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
    })
    const asm = await assembleV2([{ manifest: claudeV2.manifest, module: claudeV2 }], {
      config,
      log: silent,
      eventLog,
      capabilities,
    })
    assert.deepEqual(asm.order, ['executor-claude-v2'])
    const sub = eventLog.lag().find((x) => x.subscriber === 'executor-claude-v2')
    assert.equal(sub?.kind, 'session.open.requested')
  } finally {
    store.close()
  }
})

test('session.turn.ended：轮次持久化，重启后可查', async () => {
  const { store, eventLog } = await setup()
  try {
    eventLog.append({
      id: 'turn:1',
      kind: 'session.turn.ended',
      source: 'kernel',
      subject: 'sess-work-open-1',
      payload: { sessionId: 'sess-work-open-1', text: 'done' },
    })
    await eventLog.tick()
    assert.equal(store.getSessionTurns('sess-work-open-1'), 1)
    eventLog.append({
      id: 'turn:2',
      kind: 'session.turn.ended',
      source: 'kernel',
      subject: 'sess-work-open-1',
      payload: { sessionId: 'sess-work-open-1', text: 'again' },
    })
    await eventLog.tick()
    assert.equal(store.getSessionTurns('sess-work-open-1'), 2)
  } finally {
    store.close()
  }
})
