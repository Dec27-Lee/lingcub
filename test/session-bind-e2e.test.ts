import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema, type Config, type Projects } from '../src/kernel/config.ts'
import { createEffectRouter } from '../src/kernel/effect-router.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { createDeliver } from '../src/kernel/pipeline.ts'
import { createGate } from '../src/kernel/policy.ts'
import { openStore } from '../src/kernel/store.ts'
import { registerKernelCapabilities } from '../src/kernel/kernel-capabilities.ts'
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}

test('session.bind：改绑走发件箱，会话执行器 id 与工作区一起更新', async () => {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({ store: { path: ':memory:' }, mode: 'auto' })
    const projects: Projects = { workspaces: [] }
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map(),
    } as unknown as Ports
    store.insertSession({
      id: 's1',
      chatId: 'c1',
      threadId: 't1',
      executor: 'claude',
      workspace: 'old-ws',
      sessionId: 'old-exec',
      status: 'idle',
      createdAt: '2026-11-04T00:00:00Z',
      lastActiveAt: '2026-11-04T00:00:00Z',
    })
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }), { log: silent })
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
      enqueue: createEffectRouter({ store, outbox, config, projects }),
    })
    const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
    registerKernelCapabilities({ capabilities, config, projects, rules, ports, store, log: silent })

    const r = await capabilities.submit(
      'session.bind',
      { sessionId: 's1', executorSessionId: 'old-exec', workspace: 'new-ws' },
      { caller: 'scenario-console', opKey: 'bind:1' },
    )
    assert.equal(r.status, 'submitted')
    assert.equal(store.listOutbox('pending', 1)[0]?.action.kind, 'rebind_session')
    await outbox.tick()
    const session = store.getSession('s1')
    assert.equal(session?.sessionId, 'old-exec')
    assert.equal(session?.workspace, 'new-ws')
    assert.equal(session?.status, 'active')
  } finally {
    store.close()
  }
})


test('session.attach：无会话行时新建，已有话题时改绑', async () => {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({ store: { path: ':memory:' }, mode: 'auto' })
    const projects: Projects = { workspaces: [] }
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map(),
    } as unknown as Ports
    store.insertSession({
      id: 's-old',
      chatId: 'c1',
      threadId: 't1',
      executor: 'claude',
      workspace: 'old-ws',
      sessionId: 'old-exec',
      status: 'active',
      createdAt: '2026-11-04T00:00:00Z',
      lastActiveAt: '2026-11-04T00:00:00Z',
    })
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }), { log: silent })
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
      enqueue: createEffectRouter({ store, outbox, config, projects }),
    })
    const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
    registerKernelCapabilities({ capabilities, config, projects, rules, ports, store, log: silent })

    await capabilities.submit(
      'session.attach',
      {
        chatId: 'c1',
        threadId: 't2',
        rootMessageId: 'r2',
        executorSessionId: 'live-abcdefghijkl',
        workspace: 'new-ws',
        executor: 'claude',
      },
      { caller: 'scenario-console', opKey: 'attach:1' },
    )
    await outbox.tick()
    const created = store.getSession('s-attach-live-abcdefg')
    assert.equal(created?.sessionId, 'live-abcdefghijkl')
    assert.equal(created?.threadId, 't2')

    await capabilities.submit(
      'session.attach',
      { chatId: 'c1', threadId: 't1', executorSessionId: 'live-zzzzzzzzzzzz', workspace: 'new-ws' },
      { caller: 'scenario-console', opKey: 'attach:2' },
    )
    await outbox.tick()
    assert.equal(store.getSession('s-old')?.sessionId, 'live-zzzzzzzzzzzz')
  } finally {
    store.close()
  }
})
