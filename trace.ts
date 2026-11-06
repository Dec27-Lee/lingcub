import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadConfigLayered, loadProjects } from './src/kernel/config.ts'
import { openStore } from './src/kernel/store.ts'
import { Pipeline, createDeliver } from './src/kernel/pipeline.ts'
import { Outbox } from './src/kernel/outbox.ts'
import { loadRules } from './src/routing/rules.ts'
import { assemble, PLUGIN_DIR } from './src/kernel/wiring.ts'

const root = process.cwd()
const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
const log = (l: string, m: string): void => process.stdout.write(`[${l}] ${m}\n`)

// 用 VACUUM INTO 复制（WAL 里未落盘的也带上），别在活库上跑
const target = '/tmp/probe2.db'
try { rmSync(target) } catch {}
const src = new DatabaseSync(resolve(root, 'data/lingcub.db'), { readOnly: true })
src.exec(`VACUUM INTO '${target}'`)
const raw = JSON.parse((src.prepare('SELECT raw FROM events ORDER BY rowid DESC LIMIT 1').get() as { raw: string }).raw)
src.close()

const assembled = await assemble(PLUGIN_DIR, config, log)
const ports = (assembled as unknown as { ports: unknown }).ports ?? assembled
const store = openStore('/tmp/probe2.db')
const projects = loadProjects(resolve(root, 'config/projects.yaml'))
const rules = loadRules(resolve(root, 'config/rules.yaml'))
const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log } as never))

// 分类器（真调模型），复现运行时的注入
const classifierPlugin = config.classifiers['llm']
const classifier = classifierPlugin
  ? { impl: (ports as { classifiers: Map<string, unknown> }).classifiers.get(classifierPlugin.plugin) as never, minConfidence: classifierPlugin.minConfidence }
  : undefined

const pipeline = new Pipeline({ store, outbox, config, projects, rules, ports, sessions: store, log, classifier } as never)
const { mapMessage } = await import('./src/plugin-kit/map.ts')
const feishuSource = await import('./src/plugins/source-feishu-im/index.ts')
const feishuCfg = feishuSource.manifest.config.parse(config.sources['feishu-im'])
const mapped = mapMessage(raw, {
  source: 'source-feishu-im',
  fields: feishuCfg.fields,
  groupValues: feishuCfg.groupValues,
} as never) as unknown as { ok: boolean; event: Record<string, unknown> }
process.stdout.write(`mapped ok=${mapped.ok} text=${String(mapped.event['text'])} thread=${String(mapped.event['threadId'])}\n`)

const outcome = await pipeline.ingest({ ...mapped.event, id: 'replay-xyz' } as never)
process.stdout.write(`ingest → ${outcome}\n`)
process.stdout.write(`outbox pending=${store.listOutbox('pending').length}\n`)
