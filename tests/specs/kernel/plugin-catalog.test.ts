import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { ConfigSchema } from '../../../src/kernel/config.ts'
import { installedPlugins } from '../../../src/kernel/plugin-v2/catalog.ts'
import type { Discovered } from '../../../src/kernel/registry.ts'
import type { DiscoveredV2 } from '../../../src/kernel/plugin-v2/index.ts'

const v1: Discovered[] = [
  {
    manifest: { id: 'source-x', kind: 'source', config: z.object({}) },
    plugin: {} as never,
  },
  {
    manifest: { id: 'channel-y', kind: 'channel', config: z.object({}) },
    plugin: {} as never,
  },
]

const v2: DiscoveredV2[] = [
  {
    dir: '',
    module: {} as never,
    manifest: {
      v: 2,
      id: 'capability-x',
      roles: ['capability'],
      activation: 'hot',
      config: z.object({}),
    },
  },
]

test('安装台账：停用/未配置的插件也在列，启用状态独立', () => {
  const config = ConfigSchema.parse({
    store: { path: ':memory:' },
    sources: { s: { plugin: 'source-x', enabled: false } },
    plugins: { cap: { plugin: 'capability-x', enabled: true } },
  })
  const all = installedPlugins(v1, v2, config)
  assert.deepEqual(all.map((p) => p.id), ['capability-x', 'channel-y', 'source-x'])
  const byId = new Map(all.map((p) => [p.id, p]))
  assert.equal(byId.get('source-x')?.enabled, false)
  assert.equal(byId.get('source-x')?.configured, true)
  assert.equal(byId.get('channel-y')?.enabled, false)
  assert.equal(byId.get('channel-y')?.configured, false)
  assert.equal(byId.get('capability-x')?.enabled, true)
  assert.equal(byId.get('capability-x')?.activation, 'hot')
  assert.equal(byId.get('source-x')?.activation, 'restart')
})

test('安装台账：已启用但控制权未就绪的插件带 gate', () => {
  const scenario = {
    dir: '',
    module: {} as never,
    manifest: {
      v: 2 as const,
      id: 'scenario-x',
      roles: ['scenario' as const],
      owns: ['status' as const],
      config: z.object({}),
    },
  }
  const config = ConfigSchema.parse({
    store: { path: ':memory:' },
    scenarios: { x: { plugin: 'scenario-x', enabled: true } },
  })
  const p = installedPlugins([], [scenario], config).find((x) => x.id === 'scenario-x')
  assert.match(String(p?.gate), /status=pipeline/)
})
