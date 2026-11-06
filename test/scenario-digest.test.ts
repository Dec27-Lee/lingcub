import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as digest from '../src/plugins/scenario-digest/index.ts'
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
const now = Date.now()
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString()

test('summarize：按 kind 计数、空窗有兜底、顺序稳定', () => {
  assert.equal(digest.summarize([]), '这个时间窗没有事件。')
  assert.equal(
    digest.summarize([{ kind: 'b' }, { kind: 'a' }, { kind: 'b' }, { kind: 'c' }]),
    '近窗事件 4 条：\nb 2\na 1\nc 1',
  )
})

test('#日报：只统计窗口内事件', async () => {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
      scenarios: { digest: { plugin: 'scenario-digest', enabled: true, windowHours: 1 } },
    })
    const sent: string[] = []
    const channel = { send: async (a: { text?: string }) => (sent.push(a.text ?? ''), { status: 'sent' }) } as unknown as Channel
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
    const asm = await assembleV2([{ manifest: digest.manifest, module: digest }], {
      config,
      log: silent,
      eventLog,
      capabilities,
    })
    try {
      store.appendEventLog({ id: 'old', kind: 'state.changed', source: 'x', at: iso(2 * 3600_000), payload: {} })
      store.appendEventLog({ id: 'e1', kind: 'effect.done', source: 'kernel', at: iso(10 * 60_000), payload: {} })
      const e: Event = {
        id: 'ev-d',
        source: 'source-feishu-im',
        externalId: 'om-d',
        receivedAt: iso(0),
        occurredAt: iso(0),
        actor: { id: 'ou_1' },
        channel: { kind: 'group', id: 'oc_1' },
        text: '#日报',
        raw: {},
      }
      eventLog.appendMessage(e)
      await eventLog.tick()
      await outbox.tick()
      assert.equal(sent.length, 1)
      assert.match(sent[0] ?? '', /近窗事件 2 条/)
      assert.match(sent[0] ?? '', /message\.received 1/)
      assert.match(sent[0] ?? '', /effect\.done 1/)
    } finally {
      await asm.stop()
    }
  } finally {
    store.close()
  }
})



