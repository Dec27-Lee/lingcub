import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as docMemory from '../src/plugins/capability-doc-memory/index.ts'
import { fingerprint } from '../src/domain/doc-write.ts'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema } from '../src/kernel/config.ts'
import { createEffectRouter } from '../src/kernel/effect-router.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { createDeliver } from '../src/kernel/pipeline.ts'
import { assembleV2 } from '../src/kernel/plugin-v2/index.ts'
import { createGate } from '../src/kernel/policy.ts'
import { openStore } from '../src/kernel/store.ts'
import type { Ports } from '../src/kernel/wiring.ts'
import type { Ruleset } from '../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
const md = '# 计划\n\n## AI 进度\n- [ ] 写登录\n\n## 人工\n保留'

test('doc.write：内核比对后经 DocPort 只替换小节', async () => {
  const store = openStore(':memory:')
  try {
    const config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      docs: { feishu: { plugin: 'capability-doc-memory' } },
      plugins: { doc: { plugin: 'capability-doc-memory', enabled: true, markdown: md } },
    })
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map(),
      docs: new Map(),
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
    const asm = await assembleV2([{ manifest: docMemory.manifest, module: docMemory }], {
      config,
      log: silent,
      eventLog,
      capabilities,
      onPort: (id, port) => ports.docs?.set(id, port as never),
    })
    try {
      await capabilities.submit(
        'doc.write',
        { doc: 'd1', heading: 'AI 进度', body: '- [x] 写登录', revision: 'r1', fingerprint: fingerprint(md) },
        { caller: 't', opKey: 'w1' },
      )
      await outbox.tick()
      const after = await ports.docs?.get('capability-doc-memory')?.read('d1')
      assert.ok(after)
      assert.match(after.markdown, /## AI 进度\n- \[x\] 写登录\n\n## 人工/)
      assert.equal(after.revision, 'r2')

      const beforeConflict = after.markdown
      await capabilities.submit(
        'doc.write',
        { doc: 'd1', heading: 'AI 进度', body: '- [ ] 不该写', revision: 'r1', fingerprint: fingerprint(md) },
        { caller: 't', opKey: 'w2' },
      )
      await outbox.tick()
      const conflicted = await ports.docs?.get('capability-doc-memory')?.read('d1')
      assert.equal(conflicted?.markdown, beforeConflict)
    } finally {
      await asm.stop()
    }
  } finally {
    store.close()
  }
})


test('doc.write：端口提供 writeSection 时走块级替换，不整篇读写', async () => {
  const store = openStore(':memory:')
  try {
    const config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      docs: { feishu: { plugin: 'capability-doc-memory' } },
    })
    const calls: string[] = []
    const port = {
      async read() {
        calls.push('read')
        return { revision: 'r1', markdown: md }
      },
      async write() {
        calls.push('write')
        return { revision: 'r2' }
      },
      async writeSection(_doc: string, heading: string, body: string) {
        calls.push(`section:${heading}:${body}`)
        return { revision: 'r9' }
      },
    }
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map(),
      docs: new Map([['capability-doc-memory', port]]),
    } as unknown as Ports
    const deliver = createDeliver({ ports, config, projects: { workspaces: [] }, store, log: silent })
    const out = await deliver(
      {
        kind: 'update_doc',
        doc: 'd1',
        heading: 'AI 进度',
        body: '- [x] x',
        expect: { revision: 'r1', fingerprint: 'fp' },
      },
      'w-section',
    )
    assert.deepEqual(calls, ['section:AI 进度:- [x] x'])
    assert.deepEqual(out, { externalId: 'r9' })
  } finally {
    store.close()
  }
})
