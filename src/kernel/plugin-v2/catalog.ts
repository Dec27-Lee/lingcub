/** 已安装插件台账：发现 ≠ 启用；停用的插件也要能在 doctor/面板里看见。 */

import type { Config } from '../config.ts'
import type { Discovered } from '../registry.ts'
import type { DiscoveredV2 } from './index.ts'
import { resolvePluginSections } from '../config-alias.ts'
import { ownershipProblem } from './ownership.ts'

export interface InstalledPlugin {
  id: string
  api: 'v1' | 'v2'
  roles: string[]
  /** 启用后如何生效；hot 仅纯 capability，由运行时热加载 */
  activation: 'restart' | 'hot'
  enabled: boolean
  /** config 里是否有这段配置（没有 = 装上了但从未配置） */
  configured: boolean
  /** 已启用但控制权开关没切到对应档，运行时不会装配 */
  gate?: string
}

export function installedPlugins(
  v1: readonly Discovered[],
  v2: readonly DiscoveredV2[],
  config: Config,
): InstalledPlugin[] {
  const resolved = resolvePluginSections(config)
  const out: InstalledPlugin[] = []
  for (const p of v1) {
    const id = p.manifest.id
    out.push({
      id,
      api: 'v1',
      roles: [p.manifest.kind],
      activation: 'restart',
      enabled: resolved.enabled[id] === true,
      configured: Object.hasOwn(resolved.sections, id),
    })
  }
  for (const p of v2) {
    const id = p.manifest.id
    out.push({
      id,
      api: 'v2',
      roles: [...p.manifest.roles],
      activation: p.manifest.activation ?? 'restart',
      enabled: resolved.enabled[id] === true,
      configured: Object.hasOwn(resolved.sections, id),
      gate: ownershipProblem(p.manifest.owns, config.control) ?? undefined,
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
