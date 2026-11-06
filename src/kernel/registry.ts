import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  Channel,
  Classifier,
  Executor,
  Log,
  Manifest,
  Plugin,
  PluginContext,
  PluginKind,
  Source,
} from '../domain/ports.ts'

export interface Discovered {
  manifest: Manifest
  plugin: Plugin
}

/** 扫描 plugins 目录；每个子目录一个插件，入口 index.js（生产）或 index.ts（开发）。 */
export async function discoverPlugins(dir: string): Promise<Discovered[]> {
  if (!existsSync(dir)) return []
  const out: Discovered[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const base = join(dir, ent.name)
    const entry = ['index.js', 'index.ts'].map((f) => join(base, f)).find((f) => existsSync(f))
    if (!entry) continue
    const mod = (await import(pathToFileURL(entry).href)) as Partial<Plugin>
    // v2 清单由 kernel/plugin-v2 装配；这里跳过，避免用 v1 的 ctx 去调用 v2 的 setup。
    if (mod.manifest && (mod.manifest as { v?: unknown }).v === 2) continue
    if (!mod.manifest || typeof mod.setup !== 'function') {
      throw new Error(`插件 ${ent.name} 缺少 manifest 或 setup()`)
    }
    if (mod.manifest.id !== ent.name) {
      throw new Error(`插件目录名 ${ent.name} 与 manifest.id ${mod.manifest.id} 不一致`)
    }
    out.push({ manifest: mod.manifest, plugin: mod as Plugin })
  }
  return out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
}

export type PortImpl = Source | Classifier | Executor | Channel

/** 各 kind 必须具备的方法；注册的实现与 manifest 声明不符时立刻失败。 */
const REQUIRED_METHODS: Readonly<Record<PluginKind, readonly string[]>> = {
  source: ['start', 'stop'],
  classifier: ['classify'],
  executor: ['start', 'read', 'stop'],
  channel: ['send'],
}

function assertImplShape(manifest: Manifest, impl: PortImpl): void {
  const missing = REQUIRED_METHODS[manifest.kind].filter(
    (k) => typeof (impl as unknown as Record<string, unknown>)[k] !== 'function',
  )
  if (missing.length) {
    throw new Error(`插件 ${manifest.id} 声明 kind=${manifest.kind}，注册的实现缺少 ${missing.join(', ')}`)
  }
}

export interface SetupOptions {
  /** 各插件在 config 中的原始段，按插件 id 取 */
  sections: Record<string, unknown>
  log: Log
  register: (kind: PluginKind, id: string, impl: PortImpl) => void
}

/** 校验配置段（拒绝未知键）并执行 setup。setup 内不做 IO。 */
export function setupPlugins(plugins: readonly Discovered[], opts: SetupOptions): void {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const { manifest } of plugins) {
    if (seen.has(manifest.id)) errors.push(`插件 id 重复：${manifest.id}`)
    seen.add(manifest.id)
  }
  for (const [id] of Object.entries(opts.sections)) {
    if (!seen.has(id)) errors.push(`config 引用了不存在的插件：${id}`)
  }
  if (errors.length) throw new Error(`插件装配失败（${errors.length} 处）：\n  ${errors.join('\n  ')}`)

  for (const { manifest, plugin } of plugins) {
    const raw = opts.sections[manifest.id] ?? {}
    const r = manifest.config.safeParse(raw)
    if (!r.success) {
      const lines = r.error.issues.map((i) => `${manifest.id}.${i.path.join('.')}: ${i.message}`)
      throw new Error(`插件 ${manifest.id} 配置非法：\n  ${lines.join('\n  ')}`)
    }
    // zod 会静默丢弃未声明的键；这里把它们揪出来，配置写错就起不来
    const unknown = Object.keys(raw).filter((k) => !(k in (r.data as Record<string, unknown>)))
    if (unknown.length) {
      throw new Error(`插件 ${manifest.id} 配置含未声明的字段：${unknown.join(', ')}`)
    }
    const ctx: PluginContext = {
      config: r.data,
      log: (level, msg, extra) => opts.log(level, `[${manifest.id}] ${msg}`, extra),
      register: (impl) => {
        assertImplShape(manifest, impl)
        opts.register(manifest.kind, manifest.id, impl)
      },
    }
    plugin.setup(ctx)
  }
}
