import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema, type Config } from '../src/kernel/config.ts'
import { resolvePluginSections } from '../src/kernel/config-alias.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { discoverPluginsV2, assembleV2 } from '../src/kernel/plugin-v2/index.ts'
import { buildPluginGraph } from '../src/kernel/plugin-v2/graph.ts'
import { parsePluginConfig, validateManifestV2 } from '../src/kernel/plugin-v2/validate.ts'
import { discoverPlugins } from '../src/kernel/registry.ts'
import { openStore } from '../src/kernel/store.ts'
import type { ManifestV2, PluginContextV2, PluginModuleV2 } from '../src/domain/plugin-v2.ts'

const silent = (): void => {}
const cfg = (extra: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({ store: { path: ':memory:' }, ...extra })

function deps(extra: Record<string, unknown> = {}): {
  store: ReturnType<typeof openStore>
  eventLog: EventLog
  capabilities: Capabilities
  config: Config
} {
  const store = openStore(':memory:')
  const eventLog = new EventLog(store, { log: silent })
  const capabilities = new Capabilities(store, { log: silent })
  return { store, eventLog, capabilities, config: cfg(extra) }
}

test('清单校验：合法清单通过；id/效果/依赖/未知键逐条报错', () => {
  const good: ManifestV2 = {
    v: 2,
    id: 'scenario-demo',
    roles: ['scenario'],
    provides: [{ name: 'demo.plan', effect: 'none', input: z.object({}) }],
    on: ['message.received'],
    config: z.object({}),
  }
  assert.deepEqual(validateManifestV2(good, 'scenario-demo').problems, [])

  const bad = {
    v: 2,
    id: 'wrong-id',
    roles: ['nope'],
    provides: [
      { name: 'demo.plan', effect: 'none' },
      { name: 'demo.plan', effect: 'none' },
      { name: 'session.start', effect: 'none' },
    ],
    needs: ['demo.plan', 'x.y'],
    wants: ['demo.plan'],
    on: [''],
    config: {},
    extra: 1,
  }
  const r = validateManifestV2(bad, 'scenario-demo')
  assert.equal(r.manifest, undefined)
  const text = r.problems.join('\n')
  assert.match(text, /id（wrong-id）必须等于目录名/)
  assert.match(text, /未知角色/)
  assert.match(text, /provides 能力重复/)
  assert.match(text, /不能注册内核保留能力/)
  assert.match(text, /needs 与 wants/)
  assert.match(text, /不能依赖自己提供的能力/)
  assert.match(text, /未知键：extra/)
  assert.match(text, /config 必须是 zod schema/)

  const fam = validateManifestV2(
    {
      v: 2,
      id: 'channel-feishu',
      roles: ['channel'],
      provides: [{ name: 'transport.feishu.send', effect: 'none' }],
      config: z.object({}),
    },
    'channel-feishu',
  )
  assert.match(fam.problems.join('\n'), /效果必须是 message/)

  const both = { ...good, kind: 'source' }
  assert.match(validateManifestV2(both, 'scenario-demo').problems.join('\n'), /未知键：kind/)
})

test('配置解析：v2 对象 schema 强制 strict，默认值生效', () => {
  const manifest: ManifestV2 = {
    v: 2,
    id: 'scenario-demo',
    roles: ['scenario'],
    config: z.object({ x: z.number().default(1) }),
  }
  assert.deepEqual(parsePluginConfig(manifest, {}), { x: 1 })
  assert.throws(() => parsePluginConfig(manifest, { x: 2, extra: true }), /Unrecognized key/)
})

test('能力图：needs 决定顺序，缺必需能力与环都报错，wants 不建边', () => {
  const a: ManifestV2 = {
    v: 2,
    id: 'scenario-a',
    roles: ['scenario'],
    provides: [{ name: 'a.cap', effect: 'none' }],
    config: z.object({}),
  }
  const b: ManifestV2 = {
    v: 2,
    id: 'scenario-b',
    roles: ['scenario'],
    needs: ['a.cap'],
    wants: ['z.cap'],
    config: z.object({}),
  }
  const g = buildPluginGraph([b, a])
  assert.deepEqual(g.order, ['scenario-a', 'scenario-b'])
  assert.deepEqual(g.missingNeeds, [])
  assert.deepEqual(g.missingWants, [{ plugin: 'scenario-b', capability: 'z.cap' }])

  // wants 不建边：按 id 排序就是 b 在 z 前；若把 wants 当 needs，顺序会变成 z 在 b 前
  const zPlugin: ManifestV2 = {
    v: 2,
    id: 'scenario-z',
    roles: ['scenario'],
    provides: [{ name: 'z.cap', effect: 'none' }],
    config: z.object({}),
  }
  const wPlugin: ManifestV2 = {
    v: 2,
    id: 'scenario-b',
    roles: ['scenario'],
    wants: ['z.cap'],
    config: z.object({}),
  }
  assert.deepEqual(buildPluginGraph([zPlugin, wPlugin]).order, ['scenario-b', 'scenario-z'])

  const missing = buildPluginGraph([{ ...b, needs: ['nope.cap'] }])
  assert.match(missing.problems.join('\n'), /缺少必需能力：scenario-b 需要 nope.cap/)

  const ca: ManifestV2 = {
    v: 2,
    id: 'scenario-a',
    roles: ['scenario'],
    provides: [{ name: 'a.cap', effect: 'none' }],
    needs: ['b.cap'],
    config: z.object({}),
  }
  const cb: ManifestV2 = {
    v: 2,
    id: 'scenario-b',
    roles: ['scenario'],
    provides: [{ name: 'b.cap', effect: 'none' }],
    needs: ['a.cap'],
    config: z.object({}),
  }
  const cycle = buildPluginGraph([ca, cb])
  assert.equal(cycle.cycles.length, 1)
  assert.match(cycle.problems.join('\n'), /依赖环/)
})

test('装配：setup 按依赖顺序、start 能调用依赖能力、stop 逆序', async () => {
  const calls: string[] = []
  const a: PluginModuleV2 = {
    manifest: {
      v: 2,
      id: 'scenario-a',
      roles: ['scenario'],
      provides: [{ name: 'a.cap', effect: 'none' }],
      config: z.object({}),
    },
    setup(ctx: PluginContextV2) {
      calls.push('setup-a')
      ctx.provide('a.cap', { input: z.object({ n: z.number() }), output: z.object({ ok: z.boolean() }) }, (i) => ({
        ok: i.n > 0,
      }))
    },
    start() {
      calls.push('start-a')
    },
    stop() {
      calls.push('stop-a')
    },
  }
  const b: PluginModuleV2 = {
    manifest: {
      v: 2,
      id: 'scenario-b',
      roles: ['scenario'],
      needs: ['a.cap'],
      config: z.object({}),
    },
    setup() {
      calls.push('setup-b')
    },
    async start(ctx) {
      calls.push('start-b')
      const r = await ctx.call<{ ok: boolean }>('a.cap', { n: 1 })
      calls.push(`call:${r.ok}`)
    },
    stop() {
      calls.push('stop-b')
    },
  }
  const d = deps({
    plugins: {
      'scenario-a': { plugin: 'scenario-a', enabled: true },
      'scenario-b': { plugin: 'scenario-b', enabled: true },
    },
  })
  try {
    const asm = await assembleV2(
      [
        { manifest: b.manifest, module: b },
        { manifest: a.manifest, module: a },
      ],
      { config: d.config, log: silent, eventLog: d.eventLog, capabilities: d.capabilities },
    )
    assert.deepEqual(asm.order, ['scenario-a', 'scenario-b'])
    assert.deepEqual(calls, ['setup-a', 'setup-b', 'start-a', 'start-b', 'call:true'])
    await asm.stop()
    assert.deepEqual(calls.slice(-2), ['stop-b', 'stop-a'])
    await asm.stop() // 幂等
    assert.deepEqual(calls.slice(-2), ['stop-b', 'stop-a'])
  } finally {
    d.store.close()
  }
})

test('装配：缺必需能力失败；禁用插件跳过；缺可选能力只降级', async () => {
  const d = deps()
  try {
    const needs: PluginModuleV2 = {
      manifest: { v: 2, id: 'scenario-x', roles: ['scenario'], needs: ['nope.cap'], config: z.object({}) },
      setup() {},
    }
    await assert.rejects(
      assembleV2([{ manifest: needs.manifest, module: needs }], {
        config: cfg({ plugins: { 'scenario-x': { plugin: 'scenario-x', enabled: true } } }),
        log: silent,
        eventLog: d.eventLog,
        capabilities: d.capabilities,
      }),
      /缺少必需能力/,
    )

    let setupC = 0
    const c: PluginModuleV2 = {
      manifest: { v: 2, id: 'scenario-c', roles: ['scenario'], config: z.object({}) },
      setup() {
        setupC++
      },
    }
    const disabled = cfg({
      plugins: { 'scenario-c': { plugin: 'scenario-c', enabled: false } },
    })
    const asm = await assembleV2([{ manifest: c.manifest, module: c }], {
      config: disabled,
      log: silent,
      eventLog: d.eventLog,
      capabilities: d.capabilities,
    })
    assert.equal(setupC, 0)
    assert.deepEqual(asm.order, [])
    await asm.stop()

    const wants: PluginModuleV2 = {
      manifest: { v: 2, id: 'scenario-w', roles: ['scenario'], wants: ['w.cap'], config: z.object({}) },
      setup(ctx) {
        assert.equal(ctx.has('w.cap'), false)
      },
    }
    const asm2 = await assembleV2([{ manifest: wants.manifest, module: wants }], {
      config: cfg({ plugins: { 'scenario-w': { plugin: 'scenario-w', enabled: true } } }),
      log: silent,
      eventLog: d.eventLog,
      capabilities: d.capabilities,
    })
    await asm2.stop()
  } finally {
    d.store.close()
  }
})

test('发现：v2 目录被 v2 发现器收下，v1 发现器跳过；kind+v2 直接失败', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'data', 'tmp-plugin-'))
  try {
    mkdirSync(join(dir, 'scenario-demo'))
    writeFileSync(
      join(dir, 'scenario-demo', 'index.ts'),
      `import { z } from 'zod'
export const manifest = { v: 2, id: 'scenario-demo', roles: ['scenario'], provides: [], config: z.object({}) }
export function setup() {}
`,
      'utf8',
    )
    mkdirSync(join(dir, 'source-x'))
    writeFileSync(
      join(dir, 'source-x', 'index.ts'),
      `import { z } from 'zod'
export const manifest = { id: 'source-x', kind: 'source', config: z.object({}) }
export function setup() {}
`,
      'utf8',
    )
    const v2 = await discoverPluginsV2(dir)
    assert.deepEqual(
      v2.map((p) => p.manifest.id),
      ['scenario-demo'],
    )
    const v1 = await discoverPlugins(dir)
    assert.deepEqual(
      v1.map((p) => p.manifest.id),
      ['source-x'],
    )

    mkdirSync(join(dir, 'source-both'))
    writeFileSync(
      join(dir, 'source-both', 'index.ts'),
      `import { z } from 'zod'
export const manifest = { v: 2, kind: 'source', id: 'source-both', roles: ['source'], config: z.object({}) }
export function setup() {}
`,
      'utf8',
    )
    await assert.rejects(discoverPluginsV2(dir), /同时声明 kind/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置别名：v2 段优先于旧段，enabled 透传，v2-only 配置能过 schema', () => {
  const c = cfg({
    sources: { s: { plugin: 'channel-feishu', enabled: true } },
    plugins: { feishu: { plugin: 'channel-feishu', enabled: false, extra: 1 } },
    scenarios: { demo: { plugin: 'scenario-demo' } },
  })
  const r = resolvePluginSections(c)
  assert.deepEqual(r.sections['channel-feishu'], { extra: 1 })
  assert.equal(r.enabled['channel-feishu'], false)
  assert.equal(r.enabled['scenario-demo'], true)
  assert.match(r.conflicts.join('\n'), /被旧段与 plugins\.feishu 同时引用/)

  const onlyV2 = cfg({ plugins: { p: { plugin: 'scenario-x' } } })
  assert.deepEqual(onlyV2.sources, {})
  assert.equal(onlyV2.plugins.p?.plugin, 'scenario-x')
})

test('能力图：wants 内核能力不算缺失', () => {
  const g = buildPluginGraph([
    { v: 2, id: 'p', roles: ['scenario'], wants: ['notify.reply', 'event.query'] },
  ])
  assert.deepEqual(g.missingWants, [])
})

test('清单：activation=hot 只允许无事件订阅的纯 capability', () => {
  const base = { v: 2, roles: ['capability'], activation: 'hot', config: z.object({}) }
  assert.deepEqual(validateManifestV2({ ...base, id: 'capability-x' }, 'capability-x').problems, [])
  const bad = validateManifestV2(
    { v: 2, id: 'scenario-x', roles: ['scenario'], activation: 'hot', config: z.object({}) },
    'scenario-x',
  )
  assert.match(bad.problems.join('|'), /activation=hot/)
  const subscribed = validateManifestV2(
    { v: 2, id: 'capability-y', roles: ['capability'], activation: 'hot', on: ['message.received'], config: z.object({}) },
    'capability-y',
  )
  assert.match(subscribed.problems.join('|'), /无事件订阅/)
  const sideEffect = validateManifestV2(
    {
      v: 2,
      id: 'capability-z',
      roles: ['capability'],
      activation: 'hot',
      provides: [{ name: 'hot.write', effect: 'session' }],
      config: z.object({}),
    },
    'capability-z',
  )
  assert.match(sideEffect.problems.join('|'), /effect=none/)
})
