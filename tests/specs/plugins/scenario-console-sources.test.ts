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
const t = '2026-11-09T03:00:00Z'

/** 线上死信里的真实 id 形态：钉钉 cid…/msgt…== 与飞书 oc_…/om_… 完全不是一套。 */
const DT_CHAT = 'cidVDgDOXnQKELnkivv+j78bpKK1do7L1+VpwkynFxn4jY='
const DT_MSG = 'msgt4RHB0K0qw65JSvoCk+Mng=='

interface SentCard {
  chatId: string
  replyTo?: string
  card: Record<string, unknown>
}

function feishuEvent(text: string): Event {
  return {
    id: `ev-fs-${text}`,
    source: 'source-feishu-im',
    externalId: `om-${text}`,
    receivedAt: t,
    occurredAt: t,
    actor: { id: 'ou_1' },
    channel: { kind: 'group', id: 'oc_ctrl' },
    text,
    raw: {},
    threadId: 'omt_1',
  }
}

function dingtalkEvent(text: string): Event {
  return {
    id: `ev-dt-${text}`,
    source: 'source-dingtalk-group',
    externalId: DT_MSG,
    receivedAt: t,
    occurredAt: t,
    actor: { id: 'dt-user-1' },
    channel: { kind: 'group', id: DT_CHAT },
    text,
    raw: {},
    threadId: DT_CHAT,
  }
}

async function setup(opts: { console?: Record<string, unknown> } = {}) {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_ctrl' } },
    scenarios: { console: { plugin: 'scenario-console', enabled: true, ...opts.console } },
  })
  const cards: SentCard[] = []
  const texts: string[] = []
  const channel = {
    async send(a: { kind: string; text?: string }) {
      texts.push(a.text ?? a.kind)
      return { status: 'sent' }
    },
    async sendCard(a: SentCard) {
      cards.push(a)
      return { status: 'sent', messageId: `om_card_${cards.length}` }
    },
    async pinMessage() {},
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
  return { store, eventLog, outbox, cards, texts, asm }
}

function assertNoOutboxRow(store: ReturnType<typeof openStore>): void {
  // 白名单外的事件连一条动作都不该排进来；排了就会变成线上那条 exit=2 的死信
  for (const status of ['pending', 'done', 'dead'] as const) {
    assert.equal(store.countOutbox(status), 0, `不该有 ${status} 发件箱行`)
  }
}

test('来源白名单：钉钉群的普通消息不进开窗向导，一张卡都不发', async () => {
  const s = await setup({ console: { openOnMessage: true } })
  try {
    s.eventLog.appendMessage(dingtalkEvent('把订单分页改掉'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.deepEqual(s.cards, [], '钉钉消息不能触发飞书执行器卡')
    assert.deepEqual(s.texts, [])
    assertNoOutboxRow(s.store)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('来源白名单：#status 从钉钉来也不回（会话就绑在这条钉钉话题上也不回）', async () => {
  const s = await setup()
  try {
    // 最坏情况：库里确实有一条绑在钉钉会话/话题上的行。
    // 没有来源判断时，这里会把 DT_CHAT/DT_MSG 当飞书 id 发出去 —— 正是死信那条路径。
    s.store.insertSession({
      id: 'sess-dt',
      chatId: DT_CHAT,
      threadId: DT_CHAT,
      rootMessageId: DT_MSG,
      executor: 'claude',
      workspace: 'proj',
      sessionId: 'exec-1',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.appendMessage(dingtalkEvent('#status'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.deepEqual(s.texts, [], '#status 不能回钉钉来源')
    assertNoOutboxRow(s.store)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('来源白名单：钉钉来的 #new 不关窗口、不回话', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-dt',
      chatId: DT_CHAT,
      threadId: DT_CHAT,
      rootMessageId: DT_MSG,
      executor: 'claude',
      workspace: 'proj',
      sessionId: 'exec-1',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.appendMessage(dingtalkEvent('#new'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.store.getSession('sess-dt')?.status, 'active', '#new 不该被钉钉消息触发')
    assert.deepEqual(s.texts, [])
    assertNoOutboxRow(s.store)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('飞书来源照旧：普通消息先发「选执行器」卡', async () => {
  const s = await setup({ console: { openOnMessage: true } })
  try {
    s.eventLog.appendMessage(feishuEvent('把订单分页改掉'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.cards.length, 1, '飞书消息仍然走开窗向导')
    assert.match(JSON.stringify(s.cards[0]?.card), /选执行器/)
    assert.equal(s.cards[0]?.chatId, 'oc_ctrl')
    assert.equal(s.cards[0]?.replyTo, 'om-把订单分页改掉')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('白名单默认只认飞书来源，且是按 source id 判断（可配置、不是写死渠道）', async () => {
  const defaults = consoleScene.manifest.config.parse({}) as { sources: string[] }
  assert.deepEqual(defaults.sources, ['source-feishu-im', 'source-feishu-card', 'source-feishu-card-v2'])

  // 显式把白名单改成钉钉：钉钉消息才被处理，飞书反而被跳过 —— 证明判断走的是配置
  const s = await setup({ console: { openOnMessage: true, sources: ['source-dingtalk-group'] } })
  try {
    s.eventLog.appendMessage(dingtalkEvent('把订单分页改掉'))
    s.eventLog.appendMessage(feishuEvent('把订单分页改掉'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.cards.length, 1)
    assert.equal(s.cards[0]?.chatId, DT_CHAT, '被放行的只有钉钉那条')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})
