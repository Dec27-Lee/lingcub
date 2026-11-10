import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema, type Config } from '../../../src/kernel/config.ts'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { HotCapabilityManager } from '../../../src/kernel/plugin-v2/hot.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { DiscoveredV2 } from '../../../src/kernel/plugin-v2/index.ts'

const silent = (): void => {}

function entry(): DiscoveredV2 {
  const manifest = {
    v: 2 as const,
    id: 'capability-hot',
    roles: ['capability' as const],
    activation: 'hot' as const,
    provides: [{ name: 'hot.ping', effect: 'none' as const }],
    config: z.object({}),
  }
  return {
    dir: '',
    manifest,
    module: {
      manifest,
      setup(ctx) {
        ctx.provide('hot.ping', { input: z.object({}) }, () => ({ ok: true }))
      },
    },
  }
}

function config(enabled: boolean): Config {
  return ConfigSchema.parse({
    store: { path: ':memory:' },
    plugins: { hot: { plugin: 'capability-hot', enabled } },
  })
}

test('hot 能力：启用即注册，停用即注销', async () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    const bus = new EventLog(store, { log: silent })
    const mgr = new HotCapabilityManager({ capabilities: caps, eventLog: bus, log: silent })

    const on = await mgr.sync([entry()], config(true))
    assert.deepEqual(on.loaded, ['capability-hot'])
    assert.deepEqual(await caps.call('hot.ping', {}, { caller: 't' }), { ok: true })

    const off = await mgr.sync([entry()], config(false))
    assert.deepEqual(off.unloaded, ['capability-hot'])
    assert.equal(caps.has('hot.ping'), false)
  } finally {
    store.close()
  }
})

test('hot 能力：setup 抛错时回收已注册能力', async () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    const bus = new EventLog(store, { log: silent })
    const mgr = new HotCapabilityManager({ capabilities: caps, eventLog: bus, log: silent })
    const bad = entry()
    bad.module.setup = (ctx) => {
      ctx.provide('hot.ping', { input: z.object({}) }, () => ({}))
      throw new Error('boom')
    }
    const r = await mgr.sync([bad], config(true))
    assert.equal(r.errors.length, 1)
    assert.equal(caps.has('hot.ping'), false)
    assert.deepEqual(mgr.loaded(), [])
  } finally {
    store.close()
  }
})

test('hot 加载冲突：不删除别的提供者的同名能力', async () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    const bus = new EventLog(store, { log: silent })
    caps.provide({ name: 'hot.ping', effect: 'none', input: z.object({}) }, () => ({ other: true }), {
      provider: 'hot',
    })
    const mgr = new HotCapabilityManager({ capabilities: caps, eventLog: bus, log: silent })
    const r = await mgr.sync([entry()], config(true))
    assert.equal(r.errors.length, 1)
    assert.equal(caps.providerOf('hot.ping'), 'hot')
    assert.deepEqual(await caps.call('hot.ping', {}, { caller: 't' }), { other: true })
  } finally {
    store.close()
  }
})
