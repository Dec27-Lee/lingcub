import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeReply } from '../src/plugins/scenario-focus-dm/index.ts'
import * as focusScene from '../src/plugins/scenario-focus-dm/index.ts'
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
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
const t = '2026-11-06T05:00:00Z'

async function setup(over: Record<string, unknown> = {}) {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_ctrl' } },
    scenarios: { 'focus-dm': { plugin: 'scenario-focus-dm', enabled: true, dmChatId: 'oc_dm', ...over } },
  })
  const cards: { chatId: string; card: Record<string, unknown> }[] = []
  const dms: { userId: string; card: Record<string, unknown> }[] = []
  const channel = {
    async send() {
      return { status: 'sent' }
    },
    async sendCard(a: { chatId: string; card: Record<string, unknown> }) {
      cards.push(a)
      return { status: 'sent', messageId: `om_${cards.length}` }
    },
    async sendDm(a: { userId: string; card: Record<string, unknown> }) {
      dms.push(a)
      return { status: 'sent', messageId: `om_dm_${dms.length}` }
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
  registerKernelCapabilities({ capabilities, config, projects: { workspaces: [] }, rules, ports, store, log: silent })
  const asm = await assembleV2([{ manifest: focusScene.manifest, module: focusScene }], {
    config,
    log: silent,
    eventLog,
    capabilities,
  })
  return { store, eventLog, outbox, cards, dms, asm }
}

function seedSession(store: ReturnType<typeof openStore>): void {
  store.insertSession({
    id: 'sess-1',
    chatId: 'oc_ctrl',
    threadId: 'omt_1',
    rootMessageId: 'om_root',
    title: '修订单分页',
    executor: 'claude',
    workspace: 'E:\\Develop_E\\lingcub',
    sessionId: 'c510e321',
    status: 'active',
    createdAt: t,
    lastActiveAt: t,
  })
}

test('重点私聊：窗口等你回答 → 私聊一张卡，不发到群里', async () => {
  const s = await setup({ batchMs: 0 })
  try {
    seedSession(s.store)
    s.eventLog.append({
      id: 'ask-1',
      kind: 'session.ask.requested',
      source: 'kernel',
      payload: { sessionId: 'sess-1', question: '要合并到主分支吗？' },
    })
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.cards.length, 1)
    assert.equal(s.cards[0]?.chatId, 'oc_dm', '只走私聊')
    const body = JSON.stringify(s.cards[0]?.card)
    assert.match(body, /等你回答/)
    assert.match(body, /修订单分页/)
    assert.match(body, /要合并到主分支吗/)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('重点私聊：同一窗口同一类在去重桶内只发一条', async () => {
  const s = await setup({ batchMs: 0 })
  try {
    seedSession(s.store)
    for (const id of ['ask-a', 'ask-b']) {
      s.eventLog.append({
        id,
        kind: 'session.ask.requested',
        source: 'kernel',
        payload: { sessionId: 'sess-1', question: '选哪个？' },
      })
    }
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.cards.length, 1, '10 分钟内不重复打扰')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('重点私聊：跑完的总结默认不发（避免多窗口刷屏），开了才发', async () => {
  const quiet = await setup()
  try {
    seedSession(quiet.store)
    quiet.eventLog.append({
      id: 'turn-1',
      kind: 'session.turn.ended',
      source: 'kernel',
      payload: { sessionId: 'sess-1', text: '改完了' },
    })
    await quiet.eventLog.tick()
    await quiet.outbox.tick()
    assert.equal(quiet.cards.length, 0)
  } finally {
    await quiet.asm.stop()
    quiet.store.close()
  }

  const loud = await setup({ notifyOnTurnEnd: true })
  try {
    seedSession(loud.store)
    loud.eventLog.append({
      id: 'turn-2',
      kind: 'session.turn.ended',
      source: 'kernel',
      payload: { sessionId: 'sess-1', text: '改完了' },
    })
    await loud.eventLog.tick()
    await loud.outbox.tick()
    assert.equal(loud.cards.length, 1)
    assert.match(JSON.stringify(loud.cards[0]?.card), /✅ 修订单分页/)
  } finally {
    await loud.asm.stop()
    loud.store.close()
  }
})

test('重点私聊：没配 dmChatId 就完全静默（不改群，也不报错）', async () => {
  const s = await setup({ dmChatId: '', batchMs: 0 })
  try {
    seedSession(s.store)
    s.eventLog.append({
      id: 'ask-nodm',
      kind: 'session.ask.requested',
      source: 'kernel',
      payload: { sessionId: 'sess-1', question: '在吗' },
    })
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.deepEqual(s.cards, [])
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})
test('重点私聊：两个窗口同时找你 → 合成一条，而不是刷两条', async () => {
  const s = await setup({ batchMs: 20 })
  try {
    seedSession(s.store)
    s.store.insertSession({
      id: 'sess-2',
      chatId: 'oc_ctrl',
      threadId: 'omt_2',
      rootMessageId: 'om_root_2',
      title: '修登陆页',
      executor: 'dsh',
      workspace: 'E:\\Develop_E\\tt',
      sessionId: 'dsh-2',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    s.eventLog.append({
      id: 'ask-x1',
      kind: 'session.ask.requested',
      source: 'kernel',
      payload: { sessionId: 'sess-1', question: '要合并吗？' },
    })
    s.eventLog.append({
      id: 'ask-x2',
      kind: 'session.ask.requested',
      source: 'kernel',
      payload: { sessionId: 'sess-2', question: '要不要重建索引？' },
    })
    await s.eventLog.tick()
    await new Promise((r) => setTimeout(r, 80))
    await s.outbox.tick()
    assert.equal(s.cards.length, 1, '两个窗口要合成一条')
    const body = JSON.stringify(s.cards[0]?.card)
    assert.match(body, /2 个窗口在等你/)
    assert.match(body, /修订单分页/)
    assert.match(body, /修登陆页/)
    assert.equal(s.cards[0]?.chatId, 'oc_dm')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('重点私聊：单窗口不聚合，仍是一张单卡（标题带窗口名）', async () => {
  const s = await setup({ batchMs: 20 })
  try {
    seedSession(s.store)
    s.eventLog.append({
      id: 'ask-solo',
      kind: 'session.ask.requested',
      source: 'kernel',
      payload: { sessionId: 'sess-1', question: '要合并吗？' },
    })
    await s.eventLog.tick()
    await new Promise((r) => setTimeout(r, 80))
    await s.outbox.tick()
    assert.equal(s.cards.length, 1)
    assert.match(JSON.stringify(s.cards[0]?.card), /等你回答/)
    assert.doesNotMatch(JSON.stringify(s.cards[0]?.card), /个窗口在等你/)
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})
test('重点私聊：填了 dmUserId 就按 open_id 直发，不需要 p2p 会话 id', async () => {
  const s = await setup({ dmChatId: '', dmUserId: 'ou_37acf2c3089764fd8bd68b447251a293', batchMs: 0 })
  try {
    seedSession(s.store)
    s.eventLog.append({
      id: 'ask-dmuser',
      kind: 'session.ask.requested',
      source: 'kernel',
      payload: { sessionId: 'sess-1', question: '要合并吗？' },
    })
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.dms.length, 1, '按人发要走 dm_send')
    assert.equal(s.dms[0]?.userId, 'ou_37acf2c3089764fd8bd68b447251a293')
    assert.match(JSON.stringify(s.dms[0]?.card), /等你回答/)
    assert.deepEqual(s.cards, [], '不该再往群里发')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})

test('重点私聊：dmUserId 与 dmChatId 都填时，按人优先', async () => {
  const s = await setup({ dmChatId: 'oc_dm', dmUserId: 'ou_x', batchMs: 0 })
  try {
    seedSession(s.store)
    s.eventLog.append({
      id: 'ask-both',
      kind: 'session.ask.requested',
      source: 'kernel',
      payload: { sessionId: 'sess-1', question: '选哪个？' },
    })
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.dms.length, 1)
    assert.deepEqual(s.cards, [])
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})
test('私聊摘要：结论在第一句收口，要点分行，不把句子截断', () => {
  const text = [
    '## 对方的修复',
    '问题是构建端对话页进入即卡死（运维 task_3c960393）。',
    '根因是消息投影里重复渲染了 run-question。',
    '已经改成按 part id 去重，并补了回归测试。',
    '其余细节见话题。',
  ].join('\n')
  const s = summarizeReply(text, 240)
  assert.equal(s.lead, '问题是构建端对话页进入即卡死（运维 task_3c960393）。', '首句当结论，去掉 markdown 标题')
  assert.ok(s.points.length >= 1, '至少带一条要点')
  assert.ok(!s.points[0]?.includes('##'), '要点里不该留 markdown 井号')
  assert.ok(!s.points.some((x) => /^[-*•]/.test(x)), '要点里不该留列表符号')
  assert.equal(s.more, true, '还有内容要提示「进话题看全文」')
  // 超长首句：句号处没有合适断点才硬截，且要带省略号
  const long = summarizeReply('一'.repeat(300), 100)
  assert.equal(long.lead.length, 101, '硬截到上限 + 省略号')
})

test('私聊标题：只放窗口名，过长截断（状态用 ✅ 和卡片颜色表达）', () => {
  assert.equal(focusScene.shortTitle('tongclaw 变更文件图片预览'), 'tongclaw 变更文件图片预览')
  const long = focusScene.shortTitle('窗'.repeat(40))
  assert.ok(long.endsWith('…'), '超长标题要截断加省略号')
  assert.ok(long.length <= 25, '截断后不超过 24 字 + 省略号')
})
