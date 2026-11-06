import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as scenario from '../src/plugins/scenario-dev-dispatch/index.ts'
import * as consoleScene from '../src/plugins/scenario-console/index.ts'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema, type Config, type Projects } from '../src/kernel/config.ts'
import { createEffectRouter } from '../src/kernel/effect-router.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { Pipeline, createDeliver } from '../src/kernel/pipeline.ts'
import { assembleV2 } from '../src/kernel/plugin-v2/index.ts'
import { createGate } from '../src/kernel/policy.ts'
import { openStore } from '../src/kernel/store.ts'
import type { Channel, Executor } from '../src/domain/ports.ts'
import type { Event, Work } from '../src/domain/types.ts'
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = {
  rules: [{ id: 'always', when: { always: true }, then: { kind: 'bug', topic: '修登录', confidence: 0.95, project: 'proj' } }],
  allowlist: { groups: [], people: [], keywords: [] },
}

test('入口单消费者：bus 模式 Pipeline 只落库，场景派工一次', async () => {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      control: { status: 'pipeline', stop: 'pipeline', new: 'pipeline', messages: 'bus' },
      executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\ws'] } },
      scenarios: {
        'dev-dispatch': { plugin: 'scenario-dev-dispatch', enabled: true, project: 'proj' },
        console: { plugin: 'scenario-console', enabled: true },
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
    const channel = {
      send: async () => ({ status: 'sent' }),
      sendCard: async () => ({ messageId: 'om_card' }),
    } as unknown as Channel
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-dingtalk', channel]]),
    } as unknown as Ports
    const eventLog = new EventLog(store, { log: silent })
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }), { log: silent })
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
      enqueue: createEffectRouter({ store, outbox, config, projects }),
    })
    registerKernelCapabilities({ capabilities, config, projects, rules, ports, store, log: silent })
    const asm = await assembleV2(
      [
        { manifest: scenario.manifest, module: scenario },
        { manifest: consoleScene.manifest, module: consoleScene },
      ],
      {
        config,
        log: silent,
        eventLog,
        capabilities,
      },
    )
    const pipeline = new Pipeline({ store, outbox, config, projects, rules, ports, log: silent })
    try {
      const e: Event = {
        id: 'ev-bus',
        source: 'dingtalk',
        externalId: 'ext-bus',
        receivedAt: '2026-11-04T05:00:00Z',
        occurredAt: '2026-11-04T05:00:00Z',
        actor: { id: 'u1' },
        channel: { kind: 'dm', id: 'conv1' },
        text: '登录接口报 500',
        raw: {},
      }
      assert.equal(await pipeline.ingest(e), 'ignored')
      assert.equal(await pipeline.ingest(e), 'duplicate')
      await eventLog.tick()
      // 旧入口不再直接派工：raw message 只落库，必须等 distribution.decided。
      assert.equal(store.countOutbox('pending'), 0)
      eventLog.append({
        id: 'dist-ev-bus',
        kind: 'distribution.decided',
        source: 'scenario-distribution',
        subject: 'conv1',
        payload: {
          event: e,
          analysis: { summary: '登录接口报 500，需要排查', status: 'ok' },
          decision: { ruleId: 'test', targets: ['dispatch'] },
        },
      })
      await eventLog.tick()
      assert.equal(store.countOutbox('pending'), 1)
      const row = store.listOutbox('pending', 1)[0]
      assert.equal((row?.action as { kind: string }).kind, 'dispatch_session')

      // bus 模式控制台命令也必须只被场景处理一次
      store.insertSession({
        id: 'sess-status',
        chatId: 'conv1',
        threadId: 't1',
        title: '导出',
        executor: 'claude',
        workspace: 'proj',
        status: 'active',
        createdAt: '2026-11-04T05:00:00Z',
        lastActiveAt: '2026-11-04T05:00:00Z',
      })
      await pipeline.ingest({ ...e, id: 'ev-status', externalId: 'ext-status', text: '#status', threadId: 't1' })
      await eventLog.tick()
      const replies = store
        .listOutbox('pending', 10)
        .filter((r) => (r.action as { kind: string }).kind === 'reply_only')
      assert.equal(replies.length, 1)
      assert.match(String((replies[0]?.action as { text?: string }).text), /窗口：导出/)

      await pipeline.ingest({ ...e, id: 'ev-stop', externalId: 'ext-stop', text: '#stop', threadId: 't1' })
      await eventLog.tick()
      assert.equal(
        store.listOutbox('pending', 20).filter((r) => (r.action as { kind: string }).kind === 'stop_session').length,
        1,
      )

      await pipeline.ingest({ ...e, id: 'ev-new', externalId: 'ext-new', text: '#new', threadId: 't1' })
      await eventLog.tick()
      const after = store.listOutbox('pending', 20)
      assert.equal(
        after.filter((r) => (r.action as { kind: string; keepExecutor?: boolean }).kind === 'stop_session').length,
        2,
      )
      assert.equal(
        after.filter((r) => (r.action as { kind: string; keepExecutor?: boolean }).keepExecutor === true).length,
        1,
      )
      assert.equal(
        after.filter((r) => String((r.action as { text?: string }).text ?? '').includes('这个窗口已关闭')).length,
        1,
      )
    } finally {
      await asm.stop()
    }
  } finally {
    store.close()
  }
})
