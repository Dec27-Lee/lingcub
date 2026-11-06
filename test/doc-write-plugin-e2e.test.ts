import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { z } from 'zod'
import * as docScene from '../src/plugins/capability-doc-feishu/index.ts'
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

interface Mountable {
  manifest: { config: z.ZodTypeAny }
  setup: (ctx: never) => void
}

function mount<T>(mod: Mountable, raw: unknown): T {
  const config = mod.manifest.config.parse(raw)
  let impl: unknown = null
  ;(mod.setup as unknown as (ctx: unknown) => void)({
    config,
    log: silent,
    registerPort: (p: unknown) => {
      impl = p
    },
  })
  assert.ok(impl, '插件没有注册 DocPort')
  return impl as T
}

test('doc.write：能力 → 发件箱 → 插件 block_replace，XML 走 stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-doc-e2e-'))
  const out = join(dir, 'update.json')
  const xml = '<h2 id="h1">AI 进度</h2><p id="p1">初始</p><h2 id="h2">其他</h2><p id="p2">保持</p>'
  const script = [
    "const fs=require('fs')",
    "const cmd=process.argv[1]",
    `if(cmd==='fetch'){process.stdout.write(JSON.stringify({ok:true,data:{document:{revision_id:3,content:${JSON.stringify(xml)}}}}))}`,
    "else{let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{fs.writeFileSync(" +
      JSON.stringify(out) +
      ",JSON.stringify({argv:process.argv.slice(1),stdin:s}));process.stdout.write(JSON.stringify({ok:true,data:{document:{revision_id:4}}}))})}",
  ].join('\n')
  const port = mount<{ read: (d: string) => Promise<unknown> }>(docScene, {
    binary: process.execPath,
    fetchXmlArgs: ['-e', script, 'fetch', '{{doc}}'],
    readArgs: ['-e', script, 'fetch', '{{doc}}'],
    writeArgs: ['-e', script, 'update', '{{doc}}', '{{startId}}', '{{endId}}', '{{revision}}'],
  })

  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({ store: { path: ':memory:' }, mode: 'auto' })
    const projects: Projects = { workspaces: [] }
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map(),
      docs: new Map([['capability-doc-feishu', port]]),
    } as unknown as Ports
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }), { log: silent })
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
      enqueue: createEffectRouter({ store, outbox, config, projects }),
    })
    const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
    registerKernelCapabilities({ capabilities, config, projects, rules, ports, store, log: silent })

    await capabilities.submit(
      'doc.write',
      { doc: 'doccnX', heading: 'AI 进度', body: '- [x] 完成', revision: '3', fingerprint: 'fp' },
      { caller: 'scenario', opKey: 'doc:1' },
    )
    await outbox.tick()
    const written = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; stdin: string }
    assert.deepEqual(written.argv, ['update', 'doccnX', 'h1', 'p1', '3'])
    assert.match(written.stdin, /<checkbox done="true">完成<\/checkbox>/)
  } finally {
    store.close()
  }
})

