import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import * as consoleScene from '../src/plugins/scenario-console/index.ts'
import * as postScene from '../src/plugins/scenario-session-post/index.ts'
import * as readyScene from '../src/plugins/scenario-session-ready/index.ts'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema, type Config } from '../src/kernel/config.ts'
import { createEffectRouter } from '../src/kernel/effect-router.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../src/kernel/kernel-capabilities.ts'
import { requestSessionOpen, registerSessionOpenHandlers } from '../src/kernel/session-open.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { createDeliver } from '../src/kernel/pipeline.ts'
import { assembleV2 } from '../src/kernel/plugin-v2/index.ts'
import { createGate } from '../src/kernel/policy.ts'
import { openStore } from '../src/kernel/store.ts'
import type { Channel, Executor } from '../src/domain/ports.ts'
import type { ManifestV2 } from '../src/domain/plugin-v2.ts'
import type { Event, SessionOpenRequest } from '../src/domain/types.ts'
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
const t = '2026-11-06T06:00:00Z'
const WS = 'E:\\Develop_E\\lingcub'

/** 假 dsh 执行器：只做端口与开窗事件，不碰真 dsh。 */
const fakeExecutor: ManifestV2 = {
  v: 2,
  id: 'executor-fake',
  roles: ['executor'],
  on: ['session.open.requested'],
  config: z.object({}).strict(),
}

function fakeExecutorSetup(ctx: Parameters<typeof consoleScene.setup>[0]): void {
  const port: Executor = {
    async start() {
      return { executor: 'dsh', sessionId: 'dsh-fake-1', workspace: WS }
    },
    async read() {
      return []
    },
    async stop() {},
    async listWorkspaces() {
      return [{ root: WS, label: 'lingcub', lastActive: 0 }]
    },
    async listSessions() {
      return []
    },
    async listLiveSessions() {
      return []
    },
  }
  ctx.registerPort(port)
  ctx.on('session.open.requested', async (e) => {
    const req = e.payload as SessionOpenRequest
    ctx.emit(
      'session.opened',
      { requestId: req.requestId, executor: 'dsh', sessionId: 'dsh-fake-1', cwd: req.work.workspace },
      { id: `opened:${req.requestId}`, subject: req.requestId },
    )
  })
}

function message(text: string): Event {
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
  }
}

test('端到端（离线）：发任务 → 选执行器 → 选工作区 → 开窗 → 会话行 → 就绪卡', async () => {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_ctrl' } },
    scenarios: {
      console: { plugin: 'scenario-console', enabled: true, openOnMessage: true },
      'session-ready': { plugin: 'scenario-session-ready', enabled: true },
      'session-post': { plugin: 'scenario-session-post', enabled: true, sources: ['source-feishu-im'] },
    },
    plugins: { 'executor-fake': { plugin: 'executor-fake', enabled: true } },
  })
  const cards: { chatId: string; replyTo?: string; card: Record<string, unknown> }[] = []
  const channel = {
    async send() {
      return { status: 'sent' }
    },
    async sendCard(a: { chatId: string; replyTo?: string; card: Record<string, unknown> }) {
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
  registerSessionOpenHandlers({ store, eventLog, log: silent })
  const outbox = new Outbox(store, createDeliver({ ports, config, projects: { workspaces: [] }, store, log: silent }), {
    log: silent,
  })
  const capabilities = new Capabilities(store, {
    log: silent,
    gate: createGate({ config, store, log: silent }),
    enqueue: createEffectRouter({ store, outbox, config, projects: { workspaces: [] } }),
  })
  registerKernelCapabilities({ capabilities, config, projects: { workspaces: [] }, rules, ports, store, log: silent })
  const asm = await assembleV2(
    [
      { manifest: consoleScene.manifest, module: consoleScene },
      { manifest: readyScene.manifest, module: readyScene },
      { manifest: postScene.manifest, module: postScene },
      { manifest: fakeExecutor, module: { setup: fakeExecutorSetup } },
    ],
    { config, log: silent, eventLog, capabilities },
  )
  // open_session 的发件箱动作交给内核会话层（真实现里由 deliver 分支处理）
  const deliverViaSessionOpen = async (): Promise<void> => {
    for (;;) {
      const rows = store.listOutbox('pending', 10)
      const open = rows.find((r) => (r.action as { kind?: string }).kind === 'open_session')
      if (!open) break
      const a = open.action as { work: SessionOpenRequest['work']; mode: SessionOpenRequest['mode'] }
      store.markOutboxDone?.(open.id, undefined)
      requestSessionOpen({ store, eventLog, work: a.work, mode: a.mode, log: silent })
      break
    }
  }

  try {
    eventLog.appendMessage(message('把订单分页改掉'))
    for (let i = 0; i < 6; i++) {
      await eventLog.tick()
      await outbox.tick()
      await deliverViaSessionOpen()
    }
    assert.equal(cards.length, 1, '第一步只回执行器卡')
    assert.match(JSON.stringify(cards[0]?.card), /选执行器/)

    eventLog.append({
      id: 'act-exec',
      kind: 'card.action',
      source: 'source-feishu-card-v2',
      payload: {
        id: 'act-exec',
        chatId: 'oc_ctrl',
        messageId: 'om_card_1',
        action: { k: 'exec', exec: 'dsh', chat: 'oc_ctrl', root: 'om-把订单分页改掉', prompt: '把订单分页改掉' },
        rawAction: '{}',
      },
    })
    for (let i = 0; i < 4; i++) {
      await eventLog.tick()
      await outbox.tick()
    }
    assert.equal(cards.length, 2, '第二步回工作区卡')
    assert.match(JSON.stringify(cards[1]?.card), /选工作区/)

    eventLog.append({
      id: 'act-pick',
      kind: 'card.action',
      source: 'source-feishu-card-v2',
      payload: {
        id: 'act-pick',
        chatId: 'oc_ctrl',
        messageId: 'om_card_2',
        action: {
          k: 'pick',
          workspaceId: WS,
          exec: 'dsh',
          chat: 'oc_ctrl',
          root: 'om-把订单分页改掉',
          prompt: '把订单分页改掉',
        },
        rawAction: '{}',
      },
    })
    await eventLog.tick()
    await outbox.tick()
    await deliverViaSessionOpen()
    for (let i = 0; i < 4; i++) {
      await eventLog.tick()
      await outbox.tick()
    }

    const sessions = store.listSessions()
    assert.equal(sessions.length, 1, '开窗成功后要落会话行')
    assert.equal(sessions[0]?.executor, 'dsh')
    assert.equal(sessions[0]?.workspace, WS)
    assert.equal(sessions[0]?.sessionId, 'dsh-fake-1')
    assert.equal(sessions[0]?.rootMessageId, 'om-把订单分页改掉', '话题绑回发起那条消息')
    assert.equal(sessions[0]?.source, 'source-feishu-im', '要带来源，结果才知道回哪')

    const ready = cards.find((c) => JSON.stringify(c.card).includes('窗口已创建'))
    assert.ok(ready, '要有就绪卡')
    assert.equal(ready?.replyTo, 'om-把订单分页改掉', '就绪卡回在话题里')

    // 第三段：话题里再说一句 → session-post 要把它投给同一个会话
    eventLog.appendMessage({
      ...message('再补个用例'),
      id: 'ev-follow',
      externalId: 'om-follow',
      threadId: 'omt_new',
      rootId: 'om-把订单分页改掉',
    })
    await eventLog.tick()
    const post = store
      .listOutbox('pending', 10)
      .find((r) => (r.action as { kind?: string }).kind === 'post_message')
    assert.ok(post, '话题里的新消息应当投给窗口')
    assert.equal((post!.action as { sessionId?: string }).sessionId, sessions[0]?.id)
    assert.equal((post!.action as { text?: string }).text, '再补个用例')
  } finally {
    await asm.stop()
    store.close()
  }
})
