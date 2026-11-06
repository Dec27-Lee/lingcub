import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigSchema, loadConfigLayered } from '../src/kernel/config.ts'
import { rescanInstalled, setPluginEnabled } from '../src/kernel/plugin-v2/plugin-admin.ts'

/** 最小 v2 纯能力插件：声明 activation=hot，按清单规则不要求重启 */
const V2_HOT = `import { z } from 'zod'
export const manifest = { v: 2, id: 'capability-demo', roles: ['capability'], activation: 'hot', config: z.object({}) }
export function setup() {}
`

const V2_SCENARIO = `import { z } from 'zod'
export const manifest = { v: 2, id: 'scenario-demo', roles: ['scenario'], config: z.object({}) }
export function setup() {}
`

const V1_SOURCE = `export const manifest = { id: 'source-demo', kind: 'source', config: {} }
export function setup() {}
`

const V1_EXECUTOR = `export const manifest = { id: 'executor-demo', kind: 'executor', config: {} }
export function setup() {}
`

/** 临时插件目录放 data/ 下（仓库已忽略 data/），import .ts 的路径与真实插件一致 */
function makePluginDir(): string {
  return mkdtempSync(join(process.cwd(), 'data', 'tmp-admin-'))
}

function addPlugin(dir: string, name: string, source: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'index.ts'), source, 'utf8')
}

const BASE = `
mode: observe
store: { path: data/lingcub.db }
sources:
  im:
    enabled: true
    plugin: source-demo
    binary: dws
scenarios:
  dispatch:
    plugin: scenario-demo
    enabled: false
    project: personal-lingcub
`

interface Root {
  dir: string
  configPath: string
  overlayPath: string
}

/** 临时 root：只放 setPluginEnabled 会读的两份文件 + 贴近真实目录布局的另两份 */
function makeRoot(): Root {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-admin-'))
  const configPath = join(dir, 'config', 'lingcub.yaml')
  const overlayPath = join(dir, 'data', 'local.json')
  mkdirSync(join(dir, 'config'), { recursive: true })
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(configPath, BASE, 'utf8')
  writeFileSync(join(dir, 'config', 'projects.yaml'), 'workspaces: []\n', 'utf8')
  writeFileSync(join(dir, 'config', 'rules.yaml'), 'rules: []\n', 'utf8')
  // 已有覆盖层字段必须保留，顺带证明开关是累加而不是重写整份文件
  writeFileSync(overlayPath, JSON.stringify({ mode: 'suggest' }, null, 2) + '\n', 'utf8')
  return { dir, configPath, overlayPath }
}

function overlay(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

test('重扫安装台账：v1/v2 合并、新装的下一轮就可见（不缓存）、目录不存在返回空', async () => {
  const dir = makePluginDir()
  try {
    addPlugin(dir, 'capability-demo', V2_HOT)
    const config = ConfigSchema.parse({
      store: { path: ':memory:' },
      plugins: { demo: { plugin: 'capability-demo', enabled: true } },
    })

    const first = await rescanInstalled(dir, config)
    assert.deepEqual(first.map((p) => p.id), ['capability-demo'])
    assert.equal(first[0]?.api, 'v2')
    assert.equal(first[0]?.activation, 'hot')
    assert.equal(first[0]?.enabled, true)
    assert.equal(first[0]?.configured, true)

    addPlugin(dir, 'source-demo', V1_SOURCE)
    addPlugin(dir, 'executor-demo', V1_EXECUTOR)
    const second = await rescanInstalled(dir, config)
    assert.deepEqual(second.map((p) => p.id), ['capability-demo', 'executor-demo', 'source-demo'])
    const source = second.find((p) => p.id === 'source-demo')
    assert.equal(source?.api, 'v1')
    assert.equal(source?.enabled, false, '没配置的插件是装上了但停用')
    assert.equal(source?.configured, false)
    assert.equal(source?.activation, 'restart')

    assert.deepEqual(await rescanInstalled(join(dir, 'missing'), config), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('开关：v2 纯能力插件写 plugins.<id>，按声明不要求重启；关闭同理', async () => {
  const pluginDir = makePluginDir()
  const root = makeRoot()
  try {
    addPlugin(pluginDir, 'capability-demo', V2_HOT)

    const on = await setPluginEnabled({ root: root.dir, id: 'capability-demo', enabled: true, pluginDir })
    assert.equal(on.applied, true, on.message)
    assert.equal(on.restartRequired, false)
    assert.match(on.message, /已启用 capability-demo/)
    assert.match(on.message, /activation=hot/)

    const written = overlay(root.overlayPath) as {
      mode: string
      plugins: Record<string, { plugin: string; enabled: boolean }>
    }
    assert.equal(written.mode, 'suggest', '原有覆盖层字段不能丢')
    assert.deepEqual(written.plugins['capability-demo'], { plugin: 'capability-demo', enabled: true })
    const cfg = loadConfigLayered(root.configPath, root.overlayPath)
    assert.equal(cfg.plugins['capability-demo']?.enabled, true)

    const off = await setPluginEnabled({ root: root.dir, id: 'capability-demo', enabled: false, pluginDir })
    assert.equal(off.applied, true, off.message)
    assert.equal(off.restartRequired, false)
    const closed = overlay(root.overlayPath) as { plugins: Record<string, { enabled: boolean }> }
    assert.equal(closed.plugins['capability-demo']?.enabled, false)
    assert.equal(loadConfigLayered(root.configPath, root.overlayPath).plugins['capability-demo']?.enabled, false)
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
    rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('开关：已有配置段沿用自己的键，不造第二份引用；这些插件要求重启', async () => {
  const pluginDir = makePluginDir()
  const root = makeRoot()
  try {
    addPlugin(pluginDir, 'scenario-demo', V2_SCENARIO)
    addPlugin(pluginDir, 'source-demo', V1_SOURCE)

    const scenario = await setPluginEnabled({ root: root.dir, id: 'scenario-demo', enabled: true, pluginDir })
    assert.equal(scenario.applied, true, scenario.message)
    assert.equal(scenario.restartRequired, true)
    assert.match(scenario.message, /scenarios\.dispatch/)
    let cfg = loadConfigLayered(root.configPath, root.overlayPath)
    assert.equal(cfg.scenarios.dispatch?.enabled, true)
    assert.equal(cfg.scenarios['scenario-demo'], undefined, '同一插件不能挂两份配置')

    const source = await setPluginEnabled({ root: root.dir, id: 'source-demo', enabled: false, pluginDir })
    assert.equal(source.applied, true, source.message)
    assert.equal(source.restartRequired, true)
    assert.match(source.message, /sources\.im/)
    cfg = loadConfigLayered(root.configPath, root.overlayPath)
    assert.equal(cfg.sources.im?.enabled, false)
    assert.equal(cfg.sources.im?.binary, 'dws', '段里其他字段不能被开关抹掉')
    assert.equal(cfg.sources['source-demo'], undefined, '同一插件不能挂两份配置')
    assert.equal((overlay(root.overlayPath) as { mode: string }).mode, 'suggest')
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
    rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('开关拒绝：未安装、executor 缺必填配置、值非法校验不过，都只返回 applied=false', async () => {
  const pluginDir = makePluginDir()
  const root = makeRoot()
  try {
    addPlugin(pluginDir, 'capability-demo', V2_HOT)
    addPlugin(pluginDir, 'executor-demo', V1_EXECUTOR)
    const before = readFileSync(root.overlayPath, 'utf8')

    const missing = await setPluginEnabled({ root: root.dir, id: 'capability-nope', enabled: true, pluginDir })
    assert.equal(missing.applied, false)
    assert.match(missing.message, /不在安装目录/)

    const executor = await setPluginEnabled({ root: root.dir, id: 'executor-demo', enabled: true, pluginDir })
    assert.equal(executor.applied, false)
    assert.match(executor.message, /executor_policies/)
    assert.match(executor.message, /allowRoots/)

    const invalid = await setPluginEnabled({
      root: root.dir,
      id: 'capability-demo',
      enabled: 'yes' as unknown as boolean,
      pluginDir,
    })
    assert.equal(invalid.applied, false)
    assert.match(invalid.message, /校验失败/)
    assert.equal(readFileSync(root.overlayPath, 'utf8'), before, '校验不过不能动已有覆盖层')
    assert.equal(existsSync(join(root.dir, 'data', 'local.json')), true)
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
    rmSync(pluginDir, { recursive: true, force: true })
  }
})
