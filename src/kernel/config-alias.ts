/**
 * 配置别名：把旧四段（sources/channels/classifiers/executor_policies）与
 * v2 段（plugins/scenarios）归一到「插件 id → 该插件的配置段」。
 *
 * 规则：
 * - 产出仍然是「一个插件一份配置」，与 002 的约定一致；
 * - `plugins.*` / `scenarios.*` 优先于旧四段（同一插件被两处引用时记一条冲突，供 doctor 显示）；
 * - `plugin` / `enabled` 是内核记账字段，不进插件配置。
 */

import type { Config } from './config.ts'

export interface ResolvedPluginSections {
  /** 插件 id → 配置段（已去掉 plugin/enabled） */
  sections: Record<string, Record<string, unknown>>
  /** 插件 id → 是否启用（缺省 true） */
  enabled: Record<string, boolean>
  /** 同一插件被两处引用：旧段被 v2 段覆盖，记下来给 doctor/告警 */
  conflicts: string[]
}

function strip(entry: Record<string, unknown>): Record<string, unknown> {
  const { plugin: _plugin, enabled: _enabled, ...rest } = entry
  return rest
}

export function resolvePluginSections(config: Config): ResolvedPluginSections {
  const sections: Record<string, Record<string, unknown>> = {}
  const enabled: Record<string, boolean> = {}
  const conflicts: string[] = []

  const legacy = (pluginId: string, entry: Record<string, unknown>, label: string): void => {
    if (sections[pluginId] !== undefined) {
      conflicts.push(`${pluginId} 被多处引用（${label}）`)
      return
    }
    sections[pluginId] = strip(entry)
    enabled[pluginId] = entry.enabled === undefined ? true : entry.enabled === true
  }

  for (const [name, s] of Object.entries(config.sources)) legacy(s.plugin, s, `sources.${name}`)
  for (const [name, s] of Object.entries(config.channels)) legacy(s.plugin, s, `channels.${name}`)
  for (const [name, s] of Object.entries(config.classifiers)) legacy(s.plugin, s, `classifiers.${name}`)
  for (const [kind, p] of Object.entries(config.executor_policies)) {
    legacy(p.plugin, p, `executor_policies.${kind}`)
  }

  const v2 = (id: string, entry: Record<string, unknown>, label: string): void => {
    if (sections[id] !== undefined) conflicts.push(`${id} 被旧段与 ${label} 同时引用，按 ${label} 生效`)
    sections[id] = strip(entry)
    enabled[id] = entry.enabled === undefined ? true : entry.enabled === true
  }
  for (const [name, s] of Object.entries(config.plugins)) v2(s.plugin ?? name, s, `plugins.${name}`)
  for (const [name, s] of Object.entries(config.scenarios)) v2(s.plugin ?? name, s, `scenarios.${name}`)

  return { sections, enabled, conflicts }
}
