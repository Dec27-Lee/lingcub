import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema, type Config, type Projects } from '../src/kernel/config.ts'
import { createEffectRouter } from '../src/kernel/effect-router.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { createDeliver } from '../src/kernel/pipeline.ts'
import { createGate } from '../src/kernel/policy.ts'
import { createReceiptSettler } from '../src/kernel/receipts.ts'
import { startSession } from '../src/kernel/session-start.ts'
import { openStore } from '../src/kernel/store.ts'
import { workId } from '../src/kernel/ids.ts'
import type { Channel, Classifier, Executor } from '../src/domain/ports.ts'
import type { Event, Intent, Work } from '../src/domain/types.ts'
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }

const event: Event = {
  id: 'ev1',
  source: 'dingtalk',
  externalId: 'msg1',
  receivedAt: '2026-11-04T05:00:00Z',
  occurredAt: '2026-11-04T05:00:00Z',
  actor: { id: 'u1', name: 'Yue' },
  channel: { kind: 'dm', id: 'conv1', name: '私聊' },
  text: '登录接口报 500',
  raw: {},
  threadId: 'conv1',
  rootId: 'msg1',
}

const intent: Intent = {
  eventId: 'ev1',
  kind: 'bug',
  topic: '修复登录 500',
  project: 'proj',
  suggestedAction: 'dispatch_session',
  rationale: '规则命中',
  confidence: 0.95,
}

function setup(mode: 'auto' | 'observe' | 'suggest' = 'auto') {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode,
    executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\ws'] } },
  })
  const projects: Projects = {
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
  }
  const started: Work[] = []
  const executor = {
    start: async (w: Work) => {
      started.push(w)
      return { executor: 'claude', sessionId: 'exec-1', workspace: w.workspace }
    },
  } as unknown as Executor
  const sent: { text: string; target: Record<string, string> }[] = []
  const channel = {
    send: async () => ({ status: 'ok', messageId: 'om_sent' }),
    sendTransport: async (input: { text: string; target: Record<string, string> }) => {
      sent.push(input)
      return { messageId: 'om_reply' }
    },
  } as unknown as Channel
  const ports = {
    sources: new Map(),
    channels: new Map([['channel-dingtalk', channel]]),
    classifiers: new Map<string, Classifier>(),
    executors: new Map([['executor-claude', executor]]),
  } as unknown as Ports
  const eventLog = new EventLog(store, { log: silent })
  const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }), {
    log: silent,
    maxAttempts: 1,
    onSettled: createReceiptSettler(store, eventLog, silent),
  })
  const capabilities = new Capabilities(store, {
    log: silent,
    gate: createGate({ config, store, log: silent }),
    enqueue: createEffectRouter({ store, outbox, config, projects }),
  })
  registerKernelCapabilities({ capabilities, config, projects, rules, ports, store, log: silent })
  capabilities.provide(
    {
      name: 'transport.dingtalk.send',
      effect: 'message',
      input: z.object({ target: z.record(z.string()), text: z.string().min(1) }),
    },
    () => {
      throw new Error('提交型能力不该被同步调用')
    },
    { provider: 'channel-dingtalk' },
  )
  return { store, config, projects, ports, eventLog, outbox, capabilities, started, sent }
}

test('task.open：落 intent/work → start_session → 会话行与收据闭环', async () => {
  const s = setup()
  try {
    s.store.insertEvent(event)
    const r = await s.capabilities.submit('task.open', { event, intent }, { caller: 'scenario-x', opKey: 'ev1' })
    assert.equal(r.status, 'submitted')
    assert.equal(s.store.countOutbox('pending'), 1)

    const ticked = await s.outbox.tick()
    assert.equal(ticked.done, 1)
    assert.equal(s.started.length, 1)
    assert.equal(s.started[0]?.prompt.includes('登录接口报 500'), true)

    const id = workId('ev1')
    const work = s.store.getWork(id)
    assert.equal(work?.status, 'running')
    assert.equal(work?.sessionId, 'exec-1')
    const session = s.store.getSession(`sess-${id}`)
    assert.equal(session?.chatId, 'conv1')
    assert.equal(session?.threadId, 'conv1')
    assert.equal(session?.sessionId, 'exec-1')
    assert.equal(session?.ownerId, 'u1')

    const call = s.store.findCapabilityCallByOpKey('ev1')
    assert.equal(call?.status, 'done')
    assert.match(call?.resultHead ?? '', /exec-1/)
    const done = s.store.eventLogAfter('effect.done', 0, 5)
    assert.equal(done.length, 1)
    assert.equal((done[0].payload as { externalId?: string }).externalId, 'exec-1')
  } finally {
    s.store.close()
  }
})

test('task.open：同一 opKey 只落一份 work/会话，不重复起会话', async () => {
  const s = setup()
  try {
    s.store.insertEvent(event)
    await s.capabilities.submit('task.open', { event, intent }, { caller: 'scenario-x', opKey: 'ev1' })
    await s.capabilities.submit('task.open', { event, intent }, { caller: 'scenario-x', opKey: 'ev1' })
    assert.equal(s.store.countOutbox('pending'), 1)
    await s.outbox.tick()
    assert.equal(s.started.length, 1)
  } finally {
    s.store.close()
  }
})

test('task.open：observe 档只记 would-do，不起会话', async () => {
  const s = setup('observe')
  try {
    s.store.insertEvent(event)
    const r = await s.capabilities.submit('task.open', { event, intent }, { caller: 'scenario-x', opKey: 'ev1' })
    assert.equal(r.status, 'would-do')
    assert.equal(s.store.countOutbox('pending'), 0)
    assert.equal(s.store.getWork(workId('ev1')), null)
    assert.equal(s.store.listConfirmations().length, 0)
  } finally {
    s.store.close()
  }
})

test('task.open：项目不存在 → 提交失败、收据 failed、不落 work', async () => {
  const s = setup()
  try {
    s.store.insertEvent(event)
    await assert.rejects(
      s.capabilities.submit(
        'task.open',
        { event, intent: { ...intent, project: 'nope' } },
        { caller: 'scenario-x', opKey: 'ev-nope' },
      ),
      /未匹配到工作区/,
    )
    assert.equal(s.store.countOutbox('pending'), 0)
    assert.equal(s.store.findCapabilityCallByOpKey('ev-nope')?.status, 'failed')
    assert.equal(s.store.getWork(workId('ev1')), null)
  } finally {
    s.store.close()
  }
})

test('transport.dingtalk.send：路由到提供者频道插件并回填 externalId', async () => {
  const s = setup()
  try {
    const r = await s.capabilities.submit(
      'transport.dingtalk.send',
      { target: { openDingtalkId: 'u1', messageId: 'msg1' }, text: '已处理：登录 500' },
      { caller: 'scenario-x', opKey: 'reply:ev1' },
    )
    assert.equal(r.status, 'submitted')
    const ticked = await s.outbox.tick()
    assert.equal(ticked.done, 1)
    assert.equal(s.sent.length, 1)
    assert.equal(s.sent[0]?.text, '已处理：登录 500')
    assert.equal(s.sent[0]?.target.openDingtalkId, 'u1')
    assert.equal(s.store.findCapabilityCallByOpKey('reply:ev1')?.status, 'done')
    assert.match(s.store.findCapabilityCallByOpKey('reply:ev1')?.resultHead ?? '', /om_reply/)
  } finally {
    s.store.close()
  }
})

test('start_session：工作区不在 allowRoots 内直接失败，不起执行器', async () => {
  const s = setup()
  try {
    await assert.rejects(
      startSession(
        {
          kind: 'start_session',
          work: {
            id: 'w-x',
            intentId: 'ev1',
            kind: 'session',
            project: 'proj',
            executor: 'claude',
            workspace: 'E:\\outside',
            prompt: 'x',
            status: 'queued',
          },
        },
        { config: s.config, ports: s.ports, store: s.store, log: silent },
      ),
      /不在允许根内/,
    )
    assert.equal(s.started.length, 0)
  } finally {
    s.store.close()
  }
})

test('start_session：#resume 走 rebind，不新增会话行', async () => {
  const s = setup()
  try {
    s.store.insertSession({
      id: 's-old',
      chatId: 'conv1',
      threadId: 'th1',
      executor: 'claude',
      workspace: 'proj',
      sessionId: 'old-exec',
      status: 'idle',
      createdAt: '2026-11-04T00:00:00Z',
      lastActiveAt: '2026-11-04T00:00:00Z',
    })
    await startSession(
      {
        kind: 'start_session',
        work: {
          id: 'w-resume',
          intentId: 'ev1',
          kind: 'session',
          project: 'proj',
          executor: 'claude',
          workspace: 'E:\\ws\\proj',
          prompt: '（已恢复历史会话）',
          resumeSessionId: 'old-exec',
          status: 'queued',
          origin: { chatId: 'conv1', threadId: 'th1', rebindSessionId: 's-old' },
        },
      },
      { config: s.config, ports: s.ports, store: s.store, log: silent },
    )
    assert.equal(s.store.getSession('s-old')?.sessionId, 'exec-1')
    assert.equal(s.store.getSession('s-old')?.status, 'active')
    assert.equal(s.store.getSession('sess-w-resume'), null)
  } finally {
    s.store.close()
  }
})
