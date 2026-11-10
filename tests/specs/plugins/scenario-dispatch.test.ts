import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import * as scenario from '../../../src/plugins/scenario-dev-dispatch/index.ts'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema, type Config, type Projects } from '../../../src/kernel/config.ts'
import { createEffectRouter } from '../../../src/kernel/effect-router.ts'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../../../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver } from '../../../src/kernel/pipeline.ts'
import { assembleV2 } from '../../../src/kernel/plugin-v2/index.ts'
import { createGate } from '../../../src/kernel/policy.ts'
import { createReceiptSettler } from '../../../src/kernel/receipts.ts'
import { openStore } from '../../../src/kernel/store.ts'
import { workId } from '../../../src/kernel/ids.ts'
import type { Channel, Classifier, Executor } from '../../../src/domain/ports.ts'
import type { Event, Work } from '../../../src/domain/types.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = {
  rules: [
    {
      id: 'always',
      when: { always: true },
      then: { kind: 'bug', topic: '修登录', confidence: 0.95, project: 'proj' },
    },
  ],
  allowlist: { groups: [], people: [], keywords: [] },
}

function message(id: string, source = 'source-dingtalk'): Event {
  return {
    id,
    source,
    externalId: `ext-${id}`,
    receivedAt: '2026-11-04T05:00:00Z',
    occurredAt: '2026-11-04T05:00:00Z',
    actor: { id: 'u1', name: 'Yue' },
    channel: { kind: 'dm', id: 'conv1' },
    text: '登录接口报 500',
    raw: {},
    threadId: 'conv1',
    rootId: 'msg1',
  }
}

function analyzed(id: string, targets = ['dispatch'], status = 'ok') {
  return {
    id: `dist-${id}`,
    kind: 'distribution.decided',
    source: 'scenario-distribution',
    subject: 'conv1',
    payload: {
      event: message(id),
      analysis: { summary: '登录接口报 500，需要排查', status },
      decision: { ruleId: 'test', targets },
    },
  }
}

async function setup(mode: 'auto' | 'suggest' = 'auto') {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode,
    executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\ws'] } },
    scenarios: {
      'dev-dispatch': { plugin: 'scenario-dev-dispatch', enabled: true, project: 'proj' },
    },
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
  const executor = {
    start: async (w: Work) => ({ executor: 'claude', sessionId: 'exec-1', workspace: w.workspace }),
  } as unknown as Executor
  const sent: { text: string; target: Record<string, string> }[] = []
  const channel = {
    send: async () => ({ status: 'ok' }),
    sendCard: async () => ({ messageId: 'om_card' }),
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
    gate: createGate({
      config,
      store,
      log: silent,
      onPending: (req, confirmationId) => {
        eventLog.append({
          id: `confirm:${confirmationId}`,
          kind: 'confirmation.requested',
          source: 'kernel',
          subject: `receipt:${req.receiptId}`,
          payload: { confirmationId, receiptId: req.receiptId, caller: req.caller, name: req.name, input: req.input },
        })
      },
    }),
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
  const asm = await assembleV2([{ manifest: scenario.manifest, module: scenario }], {
    config,
    log: silent,
    eventLog,
    capabilities,
  })
  return { store, config, projects, ports, eventLog, outbox, capabilities, sent, asm }
}

test('派工出口：distribution dispatch → task.open → 会话 → 一轮结束回执', async () => {
  const s = await setup()
  try {
    s.store.insertEvent(message('ev1'))
    s.eventLog.append(analyzed('ev1'))
    await s.eventLog.tick()
    assert.equal(s.store.countOutbox('pending'), 1)
    await s.outbox.tick()
    const sessionId = `sess-${workId('ev1')}`
    assert.equal(s.store.getSession(sessionId)?.sessionId, 'exec-1')

    s.eventLog.append({
      id: 'turn-1',
      kind: 'session.turn.ended',
      source: 'kernel',
      payload: { sessionId, text: '修好了\n已提交 PR' },
    })
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.sent.length, 1)
    assert.equal(s.sent[0]?.text, '已处理：修好了 已提交 PR')
    assert.deepEqual(s.sent[0]?.target, {
      openDingtalkId: 'u1',
      messageId: 'msg1',
      conversationId: 'conv1',
    })
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('派工出口：分发目标不含 dispatch 不派工', async () => {
  const s = await setup()
  try {
    s.store.insertEvent(message('ev-feishu'))
    s.eventLog.append(analyzed('ev-feishu', ['feishu-card']))
    await s.eventLog.tick()
    assert.equal(s.store.countOutbox('pending'), 0)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('派工场景：别的工作区的会话结束不回执', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-other',
      chatId: 'conv-other',
      ownerId: 'u1',
      rootMessageId: 'msg-other',
      executor: 'claude',
      workspace: 'other',
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    })
    s.eventLog.append({
      id: 'turn-other',
      kind: 'session.turn.ended',
      source: 'kernel',
      payload: { sessionId: 'sess-other', text: '不该发' },
    })
    await s.eventLog.tick()
    assert.equal(s.sent.length, 0)
    assert.equal(s.store.countOutbox('pending'), 0)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})








test('派工出口：建议档给反馈人回一条建议', async () => {
  const s = await setup('suggest')
  try {
    s.store.insertEvent(message('ev-s'))
    s.eventLog.append(analyzed('ev-s'))
    await s.eventLog.tick()
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.sent.length, 1)
    assert.match(s.sent[0]?.text ?? '', /建议派工：proj/)
    assert.equal(s.sent[0]?.target.openDingtalkId, 'u1')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})
