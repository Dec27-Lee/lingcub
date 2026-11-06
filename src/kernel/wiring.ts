/** 装配：config 里「谁引用了哪个插件」→ 每个插件一份配置段 → 收集四类端口。 */

import { fileURLToPath } from 'node:url'
import type { Channel, Classifier, DocPort, Executor, Log, PluginKind, Source } from '../domain/ports.ts'
import type { Config } from './config.ts'
import { discoverPlugins, setupPlugins, type Discovered, type PortImpl } from './registry.ts'

/** 插件目录跟着内核文件走：开发时是 `src/plugins`，编译后是 `dist/plugins`。 */
export const PLUGIN_DIR = fileURLToPath(new URL('../plugins', import.meta.url))

export interface Ports {
  sources: Map<string, Source>
  classifiers: Map<string, Classifier>
  executors: Map<string, Executor>
  channels: Map<string, Channel>
  /** 文档执行端口（P4c）：缺省表示没有文档能力 */
  docs?: Map<string, DocPort>
}

const EMPTY = (): Ports => ({
  sources: new Map(),
  classifiers: new Map(),
  executors: new Map(),
  channels: new Map(),
  docs: new Map(),
})

function target(ports: Ports, kind: PluginKind): Map<string, PortImpl> {
  switch (kind) {
    case 'source':
      return ports.sources as unknown as Map<string, PortImpl>
    case 'classifier':
      return ports.classifiers as unknown as Map<string, PortImpl>
    case 'executor':
      return ports.executors as unknown as Map<string, PortImpl>
    case 'channel':
      return ports.channels as unknown as Map<string, PortImpl>
  }
}

/**
 * 配置段只在一处维护：谁引用插件，那一条配置就是该插件的配置。
 * `plugin`/`enabled` 是内核记账字段，不进插件配置。
 */
export function buildSections(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const add = (pluginId: string, entry: Record<string, unknown>, label: string): void => {
    if (out[pluginId] !== undefined) {
      throw new Error(`插件 ${pluginId} 被多处引用（${label}），一个插件只能挂一份配置`)
    }
    const { plugin: _plugin, enabled: _enabled, ...rest } = entry
    out[pluginId] = rest
  }
  for (const [name, s] of Object.entries(config.sources)) add(s.plugin, s, `sources.${name}`)
  for (const [name, s] of Object.entries(config.channels)) add(s.plugin, s, `channels.${name}`)
  for (const [name, s] of Object.entries(config.classifiers)) add(s.plugin, s, `classifiers.${name}`)
  for (const [kind, p] of Object.entries(config.executor_policies)) {
    add(p.plugin, p, `executor_policies.${kind}`)
  }
  return out
}

export interface Assembled {
  ports: Ports
  discovered: string[]
  /** 完整发现结果（含停用插件），供安装台账使用 */
  installed: Discovered[]
  /** 有插件目录但没被 config 引用 */
  unused: string[]
}

/** 发现插件 + 校验配置 + setup + 检查 config 的每处引用都有端口可用。 */
export async function assemble(pluginDir: string, config: Config, log: Log): Promise<Assembled> {
  const plugins = await discoverPlugins(pluginDir)
  const sections = buildSections(config)
  const ports = EMPTY()
  setupPlugins(plugins, {
    sections,
    log,
    register: (kind, id, impl) => {
      target(ports, kind).set(id, impl)
    },
  })

  const problems: string[] = []
  const need = (label: string, pluginId: string, has: boolean): void => {
    if (!has) problems.push(`${label} 引用的插件 ${pluginId} 没有注册可用端口`)
  }
  for (const [name, s] of Object.entries(config.sources)) {
    if (s.enabled) need(`sources.${name}`, s.plugin, ports.sources.has(s.plugin))
  }
  for (const [name, c] of Object.entries(config.channels)) {
    need(`channels.${name}`, c.plugin, ports.channels.has(c.plugin))
  }
  for (const [name, c] of Object.entries(config.classifiers)) {
    need(`classifiers.${name}`, c.plugin, ports.classifiers.has(c.plugin))
  }
  for (const [kind, p] of Object.entries(config.executor_policies)) {
    need(`executor_policies.${kind}`, p.plugin, ports.executors.has(p.plugin))
  }
  if (problems.length) {
    throw new Error(`插件接线失败（${problems.length} 处）：\n  ${problems.join('\n  ')}`)
  }

  const referenced = new Set(Object.keys(sections))
  return {
    ports,
    discovered: plugins.map((p) => p.manifest.id),
    installed: plugins,
    unused: plugins.map((p) => p.manifest.id).filter((id) => !referenced.has(id)),
  }
}
