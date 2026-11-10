import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as feishu from '../../../src/plugins/scenario-feishu/index.ts'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema } from '../../../src/kernel/config.ts'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { assembleV2 } from '../../../src/kernel/plugin-v2/index.ts'
import { openStore } from '../../../src/kernel/store.ts'

const silent = (): void => {}

test('飞书待办能力：解析、认领冲突、拆分', async () => {
  const store = openStore(':memory:')
  try {
    const config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      scenarios: {
        feishu: {
          plugin: 'scenario-feishu',
          enabled: true,
          binary: process.execPath,
          readArgs: ['-e', 'process.stdout.write("- [ ] [t1] 写登录")'],
        },
      },
    })
    const capabilities = new Capabilities(store, { log: silent })
    const eventLog = new EventLog(store, { log: silent })
    const asm = await assembleV2([{ manifest: feishu.manifest, module: feishu }], {
      config,
      log: silent,
      eventLog,
      capabilities,
    })
    try {
      const doc = await capabilities.call<{ markdown: string }>(
        'feishu.read-doc',
        { url: 'https://example.feishu.cn/docx/x' },
        { caller: 't' },
      )
      assert.match(doc.markdown, /写登录/)

      const items = await capabilities.call<{ id: string; owner?: string }[]>(
        'feishu.parse-todos',
        { markdown: '- [ ] [t1] 写登录 [alice]\n- [ ] [t2] 补文档' },
        { caller: 't' },
      )
      assert.equal(items.length, 2)

      const taken = await capabilities.call<{ ok: boolean; reason?: string }>(
        'feishu.claim-todo',
        { items, id: 't1', owner: 'bob' },
        { caller: 't' },
      )
      assert.deepEqual(taken, { ok: false, reason: 'taken', items })

      const ok = await capabilities.call<{ ok: boolean }>(
        'feishu.claim-todo',
        { items, id: 't2', owner: 'bob' },
        { caller: 't' },
      )
      assert.equal(ok.ok, true)

      const parts = await capabilities.call<string[]>(
        'feishu.split-todo',
        { text: '写登录；补文档' },
        { caller: 't' },
      )
      assert.deepEqual(parts, ['写登录', '补文档'])
    } finally {
      await asm.stop()
    }
  } finally {
    store.close()
  }
})


test('feishu.read-doc：非 0 退出码直接失败', async () => {
  const store = openStore(':memory:')
  try {
    const config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      scenarios: {
        feishu: {
          plugin: 'scenario-feishu',
          enabled: true,
          binary: process.execPath,
          readArgs: ['-e', 'process.exit(3)'],
        },
      },
    })
    const capabilities = new Capabilities(store, { log: silent })
    const eventLog = new EventLog(store, { log: silent })
    const asm = await assembleV2([{ manifest: feishu.manifest, module: feishu }], {
      config,
      log: silent,
      eventLog,
      capabilities,
    })
    try {
      await assert.rejects(
        () => capabilities.call('feishu.read-doc', { url: 'https://x' }, { caller: 't' }),
        /读文档失败/,
      )
    } finally {
      await asm.stop()
    }
  } finally {
    store.close()
  }
})
