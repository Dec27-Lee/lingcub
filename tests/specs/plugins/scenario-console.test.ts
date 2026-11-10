import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as consoleScene from '../../../src/plugins/scenario-console/index.ts'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema, type Config } from '../../../src/kernel/config.ts'
import { createEffectRouter } from '../../../src/kernel/effect-router.ts'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../../../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver } from '../../../src/kernel/pipeline.ts'
import { assembleV2 } from '../../../src/kernel/plugin-v2/index.ts'
import { createGate } from '../../../src/kernel/policy.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Channel } from '../../../src/domain/ports.ts'
import type { Event } from '../../../src/domain/types.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
const t = '2026-11-04T00:00:00Z'

function event(text: string): Event {
  return {
    id: `ev-${text}`,
    source: 'source-feishu-im',
    externalId: `om-${text}`,
    receivedAt: t,
    occurredAt: t,
    actor: { id: 'ou_1' },
    channel: { kind: 'group', id: 'oc_1' },
    text,
    raw: {},
    threadId: 'th_1',
  }
}

async function setup() {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
    scenarios: { console: { plugin: 'scenario-console', enabled: true } },
  })
  const sent: string[] = []
  const channel = {
    async send(a: { kind: string; text?: string }) {
      sent.push(a.kind === 'reply_only' ? (a.text ?? '') : a.kind)
      return { status: 'sent' }
    },
  } as unknown as Channel
  const ports = {
    sources: new Map(),
    channels: new Map([['channel-feishu', channel]]),
    classifiers: new Map(),
    executors: new Map(),
  } as unknown as Ports
  const eventLog = new EventLog(store, { log: silent })
  const outbox = new Outbox(store, createDeliver({ ports, config, projects: { workspaces: [] }, store, log: silent }), {
    log: silent,
  })
  const capabilities = new Capabilities(store, {
    log: silent,
    gate: createGate({ config, store, log: silent }),
    enqueue: createEffectRouter({ store, outbox, config, projects: { workspaces: [] } }),
  })
  registerKernelCapabilities({
    capabilities,
    config,
    projects: { workspaces: [] },
    rules,
    ports,
    store,
    log: silent,
  })
  const asm = await assembleV2([{ manifest: consoleScene.manifest, module: consoleScene }], {
    config,
    log: silent,
    eventLog,
    capabilities,
  })
  return { store, eventLog, outbox, sent, asm }
}

test('控制台只读片：#status 命中已绑定会话，回一行状态', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      rootMessageId: 'om_root',
      executor: 'claude',
      workspace: 'proj',
      sessionId: 'exec-1',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.appendMessage(event('#status'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.sent.length, 1)
    assert.match(s.sent[0] ?? '', /窗口：sess-1/)
    assert.match(s.sent[0] ?? '', /状态：active/)
    assert.match(s.sent[0] ?? '', /工作区：proj/)
    assert.match(s.sent[0] ?? '', /执行器：claude/)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('控制台只读片：未绑定话题不回', async () => {
  const s = await setup()
  try {
    s.eventLog.appendMessage(event('#status'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.deepEqual(s.sent, [])
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('控制台只读片：已绑定话题的非命令不动作', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.appendMessage(event('随便聊聊'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.sent.length, 0)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('控制台写库片：#new 关窗口并回文案，不停执行器', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'claude',
      workspace: 'proj',
      sessionId: 'exec-1',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.appendMessage(event('#new'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.store.getSession('sess-1')?.status, 'stopped')
    assert.deepEqual(s.sent, ['这个窗口已关闭。直接发一条新任务，就会开一个新窗口。'])
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('控制台只读片：题卡事件读题并回显', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.store.insertQuestion({
      id: 'q1',
      sessionId: 'sess-1',
      questions: [{ question: '选哪个方案' }],
      createdAt: t,
      expiresAt: t,
    })
    s.eventLog.append({
      id: 'ev-ask',
      kind: 'session.ask.requested',
      source: 'kernel',
      subject: 'sess-1',
      at: t,
      payload: { sessionId: 'sess-1', questionId: 'q1' },
    })
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.sent.length, 1)
    assert.match(s.sent[0] ?? '', /待回答/)
    assert.match(s.sent[0] ?? '', /选哪个方案/)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('控制台只读片：授权请求回显工具与入参', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.append({
      id: 'ev-perm',
      kind: 'session.permission.requested',
      source: 'kernel',
      subject: 'sess-1',
      at: t,
      payload: { sessionId: 'sess-1', toolName: 'bash', toolInput: { cmd: 'ls' } },
    })
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.sent.length, 1)
    assert.match(s.sent[0] ?? '', /待授权：bash/)
    assert.match(s.sent[0] ?? '', /ls/)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('控制台写库片：卡片选择题回写答案', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.store.insertQuestion({
      id: 'q1',
      sessionId: 'sess-1',
      questions: [{ question: '选哪个方案' }],
      createdAt: t,
      expiresAt: t,
    })
    s.eventLog.append({
      id: 'ev-card',
      kind: 'card.action',
      source: 'source-feishu-card-v2',
      subject: 'oc_1',
      at: t,
      payload: { id: 'ev-card', chatId: 'oc_1', action: { k: 'ans', qid: 'q1', label: 'A' }, rawAction: '{}' },
    })
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.store.getQuestion('q1')?.answers['选哪个方案'], 'A')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('控制台： #help 回帮助文本一次', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      rootMessageId: 'om_root',
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.appendMessage(event('#help'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.sent.length, 1)
    assert.match(s.sent[0] ?? '', /可用命令/)
    assert.match(s.sent[0] ?? '', /#status/)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('控制台： #pin 提交置顶动作', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      rootMessageId: 'om_root',
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.appendMessage(event('#pin'))
    await s.eventLog.tick()
    const rows = s.store.listOutbox('pending', 5)
    assert.equal((rows[0]?.action as { kind: string; pin?: boolean }).kind, 'pin_card')
    assert.equal((rows[0]?.action as { pin?: boolean }).pin, true)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})
