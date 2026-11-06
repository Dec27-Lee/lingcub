/** 插件能力图：能力 → 提供者、needs 拓扑、环检测。wants 不建边（可选依赖不能升成必需）。 */

import { isKernelCapability } from '../../domain/capability-names.ts'
import type { ManifestV2 } from '../../domain/plugin-v2.ts'

export interface GraphResult {
  /** 依赖在前的启动顺序 */
  order: string[]
  missingNeeds: { plugin: string; capability: string }[]
  missingWants: { plugin: string; capability: string }[]
  cycles: string[][]
  problems: string[]
}

export function buildPluginGraph(plugins: readonly ManifestV2[]): GraphResult {
  const problems: string[] = []
  const byId = new Map<string, ManifestV2>()
  for (const p of plugins) {
    if (byId.has(p.id)) problems.push(`插件 id 重复：${p.id}`)
    byId.set(p.id, p)
  }
  const providers = new Map<string, string>()
  for (const p of plugins) {
    for (const c of p.provides ?? []) {
      const other = providers.get(c.name)
      if (other && other !== p.id) problems.push(`能力重名：${c.name}（${other} 与 ${p.id}）`)
      providers.set(c.name, p.id)
    }
  }

  const deps = new Map<string, string[]>()
  const missingNeeds: GraphResult['missingNeeds'] = []
  const missingWants: GraphResult['missingWants'] = []
  for (const p of plugins) {
    const edges: string[] = []
    for (const cap of p.needs ?? []) {
      const provider = providers.get(cap)
      // 内核能力由内核注册，不来自插件清单：视为已满足，不建边。
      if (!provider && !isKernelCapability(cap)) missingNeeds.push({ plugin: p.id, capability: cap })
      else if (provider) edges.push(provider)
    }
    for (const cap of p.wants ?? []) {
      if (!providers.has(cap) && !isKernelCapability(cap)) missingWants.push({ plugin: p.id, capability: cap })
    }
    deps.set(p.id, [...new Set(edges)].sort())
  }

  const order: string[] = []
  const state = new Map<string, 0 | 1 | 2>()
  const cycles: string[][] = []
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id) ?? 0
    if (s === 2) return
    if (s === 1) {
      const at = path.indexOf(id)
      cycles.push([...path.slice(at >= 0 ? at : 0), id])
      return
    }
    state.set(id, 1)
    for (const dep of deps.get(id) ?? []) {
      if (byId.has(dep)) visit(dep, [...path, id])
    }
    state.set(id, 2)
    order.push(id)
  }
  for (const id of [...byId.keys()].sort()) visit(id, [])

  if (missingNeeds.length) {
    for (const m of missingNeeds) problems.push(`缺少必需能力：${m.plugin} 需要 ${m.capability}`)
  }
  for (const c of cycles) problems.push(`依赖环：${c.join(' → ')}`)

  return { order, missingNeeds, missingWants, cycles, problems }
}
