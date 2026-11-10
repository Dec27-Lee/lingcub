import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as readyScene from '../../../src/plugins/scenario-session-ready/index.ts'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema } from '../../../src/kernel/config.ts'
import { createEffectRouter } from '../../../src/kernel/effect-router.ts'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../../../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver } from '../../../src/kernel/pipeline.ts'
import { assembleV2 } from '../../../src/kernel/plugin-v2/index.ts'
import { createGate } from '../../../src/kernel/policy.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Channel } from '../../../src/domain/ports.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'

const silent = (): void => {}

test('session.ready：场景发 ready 卡，内核不再拼卡片', async () => {
  const store = openStore(':memory:')
  try {
    const config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      scenarios: { ready: { plugin: 'scenario-session-ready', enabled: true } },
      channels: { feishu: { plugin: 'channel-feishu' } },
    })
    const projects = { workspaces: [] }
    const sent: unknown[] = []
    const channel = {
      send: async () => ({ status: 'sent' }),
      sendCard: async (a: { card: unknown }) => {
        sent.push(a.card)
        return { status: 'sent', messageId: 'om_ready' }
      },
    } as unknown as Channel
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map([['channel-feishu', channel]]),
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
    await assembleV2([{ manifest: readyScene.manifest, module: readyScene }], {
      config,
      log: silent,
      eventLog,
      capabilities,
    })

    eventLog.append({
      id: 'ready:req-1',
      kind: 'session.ready',
      source: 'kernel',
      payload: {
        requestId: 'req-1',
        sessionRowId: 'sess-req-1',
        executor: 'claude',
        sessionId: 'claude-1',
        cwd: 'E:\\ws',
        chatId: 'c1',
        source: 'source-feishu-im',
        rootMessageId: 'm1',
        title: '修登录',
      },
    })
    for (let i = 0; i < 2; i++) await eventLog.tick()
    await outbox.tick()

    assert.equal(sent.length, 1)
    assert.equal((sent[0] as { kind: string }).kind, 'ready')
  } finally {
    store.close()
  }
})
