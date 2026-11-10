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
const t = '2026-11-06T07:00:00Z'

function ev(text: string): Event {
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

async function setup() {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_ctrl' } },
    executor_policies: {
      claude: { plugin: 'executor-claude', allowRoots: ['E:\\Develop_E'] },
      dsh: { plugin: 'executor-dsh', allowRoots: ['E:\\Develop_E'] },
    },
    scenarios: { console: { plugin: 'scenario-console', enabled: true } },
  })
  const cards: { chatId: string; replyTo?: string; card: Record<string, unknown> }[] = []
  const texts: string[] = []
  const channel = {
    async send(a: { kind: string; text?: string }) {
      texts.push(a.text ?? a.kind)
      return { status: 'sent' }
    },
    async sendCard(a: { chatId: string; replyTo?: string; card: Record<string, unknown> }) {
      cards.push(a)
      return { status: 'sent', messageId: `om_card_${cards.length}` }
    },
    async pinMessage() {},
  } as unknown as Channel
  const dshPort = {
    async start() {
      throw new Error('不该被调用')
    },
    async read() {
      return []
    },
    async stop() {},
    async listLiveSessions() {
      return [
        {
          sessionId: 'dsh-session-1',
          cwd: 'E:\\Develop_E\\lingcub',
          title: '幺幺零项目架构开发',
          lastActive: Date.now(),
          userTurns: 0,
          running: true,
          status: 'busy' as const,
        },
      ]
    },
  }
  const ports = {
    sources: new Map(),
    channels: new Map([['channel-feishu', channel]]),
    classifiers: new Map(),
    executors: new Map([['executor-dsh', dshPort]]),
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
  const asm = await assembleV2([{ manifest: consoleScene.manifest, module: consoleScene }], {
    config,
    log: silent,
    eventLog,
    capabilities,
  })
  return { store, eventLog, outbox, cards, texts, asm }
}

test('#接入：终端里自己开的 dsh 会话也能列出来，并标明忙闲', async () => {
  const s = await setup()
  try {
    s.eventLog.appendMessage(ev('#接入'))
    await s.eventLog.tick()
    await s.outbox.tick()
    assert.equal(s.cards.length, 1, '应当回一张接入卡')
    const body = JSON.stringify(s.cards[0]?.card)
    assert.match(body, /幺幺零项目架构开发/)
    assert.match(body, /dsh/)
    // 卡头本来就有「接入正在跑的窗口」，所以这里只认按钮标签里的「· 在跑」
    assert.match(body, /· 在跑/, 'agents/live 有 busy 就要显示在选项标签上')
    assert.match(body, /k":"attach"/, '按钮要带 attach 动作')
  } finally {
    await s.asm.stop()
    s.store.close()
  }
})
