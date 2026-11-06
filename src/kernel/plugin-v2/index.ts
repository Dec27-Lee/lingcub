/** v2 插件发现与装配：校验 → 能力图 → needs 拓扑 → setup → start；stop 逆序、幂等。 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPluginContext } from './context.ts'
import { buildPluginGraph } from './graph.ts'
import { parsePluginConfig, validateManifestV2 } from './validate.ts'
import { resolvePluginSections } from '../config-alias.ts'
import type { Capabilities } from '../capabilities.ts'
import type { Config } from '../config.ts'
import type { EventLog } from '../event-log.ts'
import type { ManifestV2, PluginContextV2, PluginModuleV2 } from '../../domain/plugin-v2.ts'
import type { Log } from '../../domain/ports.ts'

export interface DiscoveredV2 {
  dir: string
  manifest: ManifestV2
  module: PluginModuleV2
}

export interface AssembleV2Options {
  config: Config
  log: Log
  eventLog: EventLog
  capabilities: Capabilities
  /** v2 插件注册端口实现；由装配方按形状放进 sources/executors/channels/classifiers */
  onPort?: (pluginId: string, port: unknown) => void
}

export interface AssembleV2Result {
  order: string[]
  contexts: Map<string, PluginContextV2>
  stop: () => Promise<void>
}

/** 只发现 `v: 2` 的插件；v1（有 kind）交给 registry.discoverPlugins。 */
export async function discoverPluginsV2(dir: string): Promise<DiscoveredV2[]> {
  if (!existsSync(dir)) return []
  const out: DiscoveredV2[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('_')) continue
    const base = join(dir, ent.name)
    const entry = ['index.js', 'index.ts'].map((f) => join(base, f)).find((f) => existsSync(f))
    if (!entry) continue
    const mod = (await import(pathToFileURL(entry).href)) as Partial<PluginModuleV2>
    const raw = mod.manifest as unknown
    if (!raw || typeof raw !== 'object') continue
    const isV2 = (raw as { v?: unknown }).v === 2
    if (!isV2) continue
    if ('kind' in (raw as object)) {
      throw new Error(`插件 ${ent.name} 同时声明 kind（v1）与 v:2，判别位必须唯一`)
    }
    const check = validateManifestV2(raw, ent.name)
    if (!check.manifest) {
      throw new Error(`插件 ${ent.name} 清单非法：\n  ${check.problems.join('\n  ')}`)
    }
    if (typeof mod.setup !== 'function') throw new Error(`插件 ${ent.name} 缺少 setup()`)
    out.push({ dir: base, manifest: check.manifest, module: mod as PluginModuleV2 })
  }
  return out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
}

export async function assembleV2(
  modules: readonly { manifest: ManifestV2; module: PluginModuleV2 }[],
  opts: AssembleV2Options,
): Promise<AssembleV2Result> {
  const sections = resolvePluginSections(opts.config)
  // v2 插件必须显式配置（plugins/scenarios 段，或旧段引用）才启动；没写配置=不装。
  const enabled = modules.filter((m) => sections.enabled[m.manifest.id] === true)
  for (const m of modules) {
    if (!enabled.includes(m)) opts.log('info', `插件 ${m.manifest.id} 未配置，跳过`)
  }

  const graph = buildPluginGraph(enabled.map((m) => m.manifest))
  if (graph.problems.length) {
    throw new Error(`v2 插件装配失败（${graph.problems.length} 处）：\n  ${graph.problems.join('\n  ')}`)
  }
  for (const w of graph.missingWants) {
    opts.log('warn', `可选能力缺失（降级）：${w.plugin} 想要 ${w.capability}`)
  }

  const byId = new Map(enabled.map((m) => [m.manifest.id, m]))
  const contexts = new Map<string, PluginContextV2>()
  for (const id of graph.order) {
    const m = byId.get(id)
    if (!m) continue
    const cfg = parsePluginConfig(m.manifest, sections.sections[id] ?? {})
    const ctx = createPluginContext({
      manifest: m.manifest,
      config: cfg,
      log: opts.log,
      eventLog: opts.eventLog,
      capabilities: opts.capabilities,
      registerPort: (port) => opts.onPort?.(m.manifest.id, port),
    })
    m.module.setup(ctx)
    contexts.set(id, ctx)
  }

  for (const id of graph.order) {
    const m = byId.get(id)
    const ctx = contexts.get(id)
    if (m?.module.start && ctx) await m.module.start(ctx)
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const id of [...graph.order].reverse()) {
      const m = byId.get(id)
      const ctx = contexts.get(id)
      if (!m?.module.stop || !ctx) continue
      try {
        await m.module.stop(ctx)
      } catch (err) {
        opts.log('warn', `插件 ${id} 停止时出错（已忽略）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return { order: graph.order, contexts, stop }
}
