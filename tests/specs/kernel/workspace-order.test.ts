import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema, type Config } from '../../../src/kernel/config.ts'
import { registerKernelCapabilities } from '../../../src/kernel/kernel-capabilities.ts'
import { openStore } from '../../../src/kernel/store.ts'
import { createGate } from '../../../src/kernel/policy.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }

const REPO = 'E:\\Develop_E\\lingcub'
const SUBDIR = 'E:\\Develop_E\\lingcub\\workspace\\updatesql'

async function mount(projects: { id: string; name: string; root: string; aliases?: string[] }[]) {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
    executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\Develop_E'] } },
  })
  const executor = {
    async start() {
      throw new Error('不该被调用')
    },
    async read() {
      return []
    },
    async stop() {},
    async listWorkspaces() {
      // 子目录比仓库根“更新”，按最近活跃排会把子目录顶到第一个
      return [
        { root: SUBDIR, label: 'updatesql', lastActive: 2000 },
        { root: REPO, label: 'lingcub', lastActive: 1000 },
      ]
    },
  }
  const ports = {
    sources: new Map(),
    channels: new Map(),
    classifiers: new Map(),
    executors: new Map([['executor-claude', executor]]),
  } as unknown as Ports
  const capabilities = new Capabilities(store, {
    log: silent,
    gate: createGate({ config, store, log: silent }),
    enqueue: () => {},
  })
  registerKernelCapabilities({
    capabilities,
    config,
    projects: { workspaces: projects as never },
    rules,
    ports,
    store,
    log: silent,
  })
  return { store, capabilities }
}

test('工作区列表：配置里登记的仓库排第一（别把子目录顶到第一个）', async () => {
  const m = await mount([{ id: 'personal-lingcub', name: '个人 · 幺幺零', root: REPO }])
  try {
    const list = await m.capabilities.call<{ root: string }[]>('workspace.list', {}, { caller: 't' })
    assert.equal(list[0]?.root, REPO, '配置过的仓库要先出现')
    assert.equal(list[1]?.root, SUBDIR)
  } finally {
    m.store.close()
  }
})

test('工作区列表：没有配置过时仍按最近活跃排序', async () => {
  const m = await mount([])
  try {
    const list = await m.capabilities.call<{ root: string }[]>('workspace.list', {}, { caller: 't' })
    assert.equal(list[0]?.root, SUBDIR, '没配置就按活跃度')
  } finally {
    m.store.close()
  }
})
test('workspace.trust：把选中的工作区交给执行器登记信任（dsh 直通）', async () => {
  const store = openStore(':memory:')
  try {
    const calls: string[] = []
    const executor = {
      async start() {
        throw new Error('不该被调用')
      },
      async read() {
        return []
      },
      async stop() {},
      async trustWorkspace(root: string) {
        calls.push(root)
        return { trusted: true, changed: true }
      },
    }
    const config: Config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
      executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\Develop_E'] } },
    })
    const ports = {
      sources: new Map(),
      channels: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
    } as unknown as Ports
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
      enqueue: () => {},
    })
    registerKernelCapabilities({ capabilities, config, projects: { workspaces: [] }, rules, ports, store, log: silent })
    const res = await capabilities.call<{ trusted: boolean; changed: boolean }>(
      'workspace.trust',
      { root: 'E:\\Develop_E\\tt\\x' },
      { caller: 't' },
    )
    assert.deepEqual(res, { trusted: true, changed: true })
    assert.deepEqual(calls, ['E:\\Develop_E\\tt\\x'], '要把选中目录交给执行器登记')
    const dsh = await capabilities.call<{ trusted: boolean }>('workspace.trust', { root: 'E:\\x', executor: 'dsh' }, { caller: 't' })
    assert.equal(dsh.trusted, true, 'dsh 没有信任概念，直通')
  } finally {
    store.close()
  }
})
