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
import type { Executor } from '../src/domain/ports.ts'
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}

test('session.post：能力 → 发件箱 → 执行器 post，正文带信封', async () => {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      executor_policies: { dsh: { plugin: 'executor-dsh', allowRoots: ['E:\\ws'] } },
    })
    const projects: Projects = {
      workspaces: [
        {
          id: 'proj',
          name: 'Proj',
          kind: 'repo',
          root: 'E:\\ws\\proj',
          executor: 'dsh',
          isolation: 'session',
          concurrency: 1,
          freshSession: true,
          aliases: [],
        },
      ],
    }
    const posted: { sessionId: string; text: string }[] = []
    const executor = {
      start: async () => ({ executor: 'dsh' as const, sessionId: 'real-1', workspace: 'E:\\ws\\proj' }),
      read: async () => [],
      stop: async () => {},
      post: async (h: { sessionId: string }, text: string) => {
        posted.push({ sessionId: h.sessionId, text })
      },
    } as unknown as Executor
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-dsh', executor]]),
      channels: new Map(),
    } as unknown as Ports
    store.insertSession({
      id: 's1',
      chatId: 'c1',
      executor: 'dsh',
      workspace: 'proj',
      sessionId: 'real-1',
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
      'session.post',
      { sessionId: 's1', text: '再补个测试' },
      { caller: 'scenario-session-post', opKey: 'post:ev1' },
    )
    assert.equal(r.status, 'submitted')
    await outbox.tick()
    assert.equal(posted.length, 1)
    assert.equal(posted[0]?.sessionId, 'real-1')
    assert.match(posted[0]?.text ?? '', /再补个测试/)
    assert.equal(store.getSession('s1')?.lastActiveAt !== '2026-11-04T00:00:00Z', true)
  } finally {
    store.close()
  }
})
