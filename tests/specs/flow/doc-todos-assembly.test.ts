import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleV2 } from '../../../src/kernel/plugin-v2/index.ts'
import * as docTodos from '../../../src/plugins/scenario-doc-todos/index.ts'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema, type Config, type Projects } from '../../../src/kernel/config.ts'
import { createEffectRouter } from '../../../src/kernel/effect-router.ts'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../../../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver } from '../../../src/kernel/pipeline.ts'
import { createGate } from '../../../src/kernel/policy.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Channel, DocPort } from '../../../src/domain/ports.ts'
import type { Event } from '../../../src/domain/types.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const silent = (): void => {}

test('待办场景装配：启用后消息进总线，回执带待办列表', async () => {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      control: { messages: 'bus' },
      scenarios: { 'doc-todos': { plugin: 'scenario-doc-todos', enabled: true } },
      channels: { feishu: { plugin: 'channel-feishu', enabled: true } },
    })
    const projects: Projects = { workspaces: [] }
    const sent: string[] = []
    const channel = {
      send: async (m: { text: string }) => {
        sent.push(m.text)
        return { status: 'ok', messageId: 'om_reply' }
      },
    } as unknown as Channel
    const doc = {
      read: async () => ({ revision: 'r1', markdown: '# 待办\n- [ ] [t1] 修复登录\n- [ ] [t2] 补测试\n' }),
      write: async () => ({ revision: 'r2' }),
    } as unknown as DocPort
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map([['channel-feishu', channel]]),
      docs: new Map([['capability-doc-feishu', doc]]),
    } as unknown as Ports
    const eventLog = new EventLog(store, { log: silent })
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }), { log: silent })
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
      enqueue: createEffectRouter({ store, outbox, config, projects }),
    })
    const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
    registerKernelCapabilities({ capabilities, config, projects, rules, ports, store, log: silent })
    await assembleV2([{ manifest: docTodos.manifest, module: docTodos }], {
      config,
      log: silent,
      eventLog,
      capabilities,
    })

    const e: Event = {
      id: 'ev-todos',
      source: 'feishu',
      externalId: 'om1',
      receivedAt: '2026-11-04T00:00:00Z',
      occurredAt: '2026-11-04T00:00:00Z',
      actor: { id: 'u1', name: 'Yue' },
      channel: { kind: 'group', id: 'oc_1' },
      text: '#待办 doc1',
      raw: {},
      threadId: 'th_1',
      rootId: 'om_root',
    }
    eventLog.appendMessage(e)
    await eventLog.tick()
    await outbox.tick()
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? '', /修复登录/)
  } finally {
    store.close()
  }
})


