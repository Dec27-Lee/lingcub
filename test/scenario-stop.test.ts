import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as consoleScene from '../src/plugins/scenario-console/index.ts'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema, type Config, type Projects } from '../src/kernel/config.ts'
import { createEffectRouter } from '../src/kernel/effect-router.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { createDeliver } from '../src/kernel/pipeline.ts'
import { assembleV2 } from '../src/kernel/plugin-v2/index.ts'
import { createGate } from '../src/kernel/policy.ts'
import { openStore } from '../src/kernel/store.ts'
import type { Channel, Executor } from '../src/domain/ports.ts'
import type { Event } from '../src/domain/types.ts'
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
const t = '2026-11-04T00:00:00Z'

test('控制台写库片：#stop 提交 session.stop 并停会话', async () => {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
      executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\ws'] } },
      scenarios: { console: { plugin: 'scenario-console', enabled: true } },
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
    let stopped = 0
    const executor = {
      start: async () => ({ executor: 'claude', sessionId: 'exec-1', workspace: 'E:\\ws\\proj' }),
      read: async () => [],
      stop: async () => {
        stopped++
      },
    } as unknown as Executor
    const channel = { send: async () => ({ status: 'sent' }) } as unknown as Channel
    const ports = {
      sources: new Map(),
      channels: new Map([['channel-feishu', channel]]),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
    } as unknown as Ports
    const eventLog = new EventLog(store, { log: silent })
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }), { log: silent })
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
      enqueue: createEffectRouter({ store, outbox, config, projects }),
    })
    registerKernelCapabilities({ capabilities, config, projects, rules, ports, store, log: silent })
    const asm = await assembleV2([{ manifest: consoleScene.manifest, module: consoleScene }], {
      config,
      log: silent,
      eventLog,
      capabilities,
    })
    try {
      store.insertSession({
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
      const e: Event = {
        id: 'ev-stop',
        source: 'source-feishu-im',
        externalId: 'om-stop',
        receivedAt: t,
        occurredAt: t,
        actor: { id: 'ou_1' },
        channel: { kind: 'group', id: 'oc_1' },
        text: '#stop',
        raw: {},
        threadId: 'th_1',
      }
      eventLog.appendMessage(e)
      await eventLog.tick()
      await outbox.tick()
      assert.equal(stopped, 1)
      assert.equal(store.getSession('sess-1')?.status, 'stopped')
    } finally {
      await asm.stop()
    }
  } finally {
    store.close()
  }
})
