import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as consoleScene from '../src/plugins/scenario-console/index.ts'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema, type Config } from '../src/kernel/config.ts'
import { createEffectRouter } from '../src/kernel/effect-router.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { createDeliver } from '../src/kernel/pipeline.ts'
import { assembleV2 } from '../src/kernel/plugin-v2/index.ts'
import { createGate } from '../src/kernel/policy.ts'
import { openStore } from '../src/kernel/store.ts'
import type { Channel } from '../src/domain/ports.ts'
import type { Event } from '../src/domain/types.ts'
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
const t = '2026-11-06T03:00:00Z'

interface SentCard {
  chatId: string
  replyTo?: string
  card: Record<string, unknown>
}

function event(text: string, over: Partial<Event> = {}): Event {
  return {
    id: `ev-${text}`,
    source: 'source-feishu-im',
    externalId: `om-${text}`,
    receivedAt: t,
    occurredAt: t,
    actor: { id: 'ou_1' },
    channel: { kind: 'group', id: 'oc_ctrl' },
    text,
    raw: {},
    threadId: 'omt_1',
    ...over,
  }
}

function appendAction(s: { eventLog: { append: (e: unknown) => unknown } }, value: Record<string, string>): void {
  s.eventLog.append({
    id: `act-${value['k'] ?? 'x'}-${value['exec'] ?? value['workspaceId'] ?? ''}`,
    kind: 'card.action',
    source: 'source-feishu-card-v2',
    payload: {
      id: `evt-${value['k'] ?? 'x'}`,
      chatId: 'oc_ctrl',
      messageId: 'om_card',
      actorId: 'ou_1',
      action: value,
      rawAction: JSON.stringify(value),
    },
  })
}

async function setup(opts: { executorPolicies?: Record<string, unknown>; executors?: [string, unknown][] } = {}) {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_ctrl' } },
    scenarios: { console: { plugin: 'scenario-console', enabled: true, openOnMessage: true } },
    ...(opts.executorPolicies ? { executor_policies: opts.executorPolicies } : {}),
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
    executors: new Map(opts.executors ?? []),
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

test('开窗向导：未绑定的普通消息先问执行器', async () => {
  const s = await setup()
  try {
    s.eventLog.appendMessage(event('把订单分页改掉'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.cards.length, 1)
    const title = JSON.stringify(s.cards[0]?.card)
    assert.match(title, /新建窗口 · 选执行器/)
    assert.match(title, /Claude Code 窗口/)
    assert.match(title, /DSH 后台会话/)
    // 回复挂在用户那条消息下面，reply-in-thread 才会长出一棵新话题
    assert.equal(s.cards[0]?.replyTo, 'om-把订单分页改掉')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('开窗向导：已绑定话题的正文不弹执行器卡（留给 session-post）', async () => {
  const s = await setup()
  try {
    s.store.insertSession({
      id: 'sess-1',
      chatId: 'oc_ctrl',
      threadId: 'omt_1',
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.appendMessage(event('继续改'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.deepEqual(s.cards, [])
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('开窗向导：选执行器后列工作区，按钮带上 exec 与话题名', async () => {
  const s = await setup()
  try {
    appendAction(s, { k: 'exec', exec: 'dsh', chat: 'oc_ctrl', root: 'om_root', prompt: '订单分页' })
    await s.eventLog.tick()
    await s.outbox.tick()
    // 没有执行器端口 → 走「没有可选工作区」分支，明确回一张提示卡而不是静默
    assert.equal(s.cards.length, 1)
    assert.match(JSON.stringify(s.cards[0]?.card), /没有可选工作区/)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('开窗向导：选工作区后提交 session.open，dsh 走 headless', async () => {
  const s = await setup()
  try {
    appendAction(s, {
      k: 'pick',
      workspaceId: 'E:\\work\\demo',
      exec: 'dsh',
      chat: 'oc_ctrl',
      root: 'om_root',
      prompt: '订单分页',
    })
    await s.eventLog.tick()
    const queued = s.store.listOutbox('pending')
    const open = queued.find((r) => (r.action as { kind?: string }).kind === 'open_session')
    assert.ok(open, '应当排进一条 open_session 动作')
    const action = open!.action as { mode?: string; work?: { executor?: string; workspace?: string; origin?: { rootMessageId?: string } } }
    assert.equal(action.mode, 'headless', 'dsh 没有终端模式')
    assert.equal(action.work?.executor, 'dsh')
    assert.equal(action.work?.workspace, 'E:\\work\\demo')
    assert.equal(action.work?.origin?.rootMessageId, 'om_root', '话题绑在发起那条消息下')
    assert.equal(action.work?.origin?.source, 'source-feishu-im', '开窗请求要带来源，结果才回得来')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('开窗向导：claude 走 terminal 模式', async () => {
  const s = await setup()
  try {
    appendAction(s, {
      k: 'pick',
      workspaceId: 'E:\\work\\demo',
      exec: 'claude',
      chat: 'oc_ctrl',
      root: 'om_root',
      prompt: '订单分页',
    })
    await s.eventLog.tick()
    const open = s.store.listOutbox('pending').find((r) => (r.action as { kind?: string }).kind === 'open_session')
    const action = open!.action as { mode?: string }
    assert.equal(action.mode, 'terminal')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})
