/** v2 场景声明的控制权：开关没切到对应档就不装配，避免与旧 Pipeline 双回。 */

import type { ManifestV2 } from '../../domain/plugin-v2.ts'

export type ControlSwitch = 'status' | 'stop' | 'new' | 'messages'

export interface ControlState {
  status?: string
  stop?: string
  new?: string
  messages?: string
}

const EXPECTED: Record<ControlSwitch, string> = {
  status: 'scenario',
  stop: 'scenario',
  new: 'scenario',
  messages: 'bus',
}

export function ownershipProblem(
  owns: readonly ControlSwitch[] | undefined,
  control: ControlState | undefined,
): string | null {
  for (const sw of owns ?? []) {
    const actual = control?.[sw] ?? 'pipeline'
    if (actual !== EXPECTED[sw]) return `${sw}=${actual}，该场景要求 ${EXPECTED[sw]}`
  }
  return null
}

export function filterByOwnership<T extends { manifest: ManifestV2 }>(
  plugins: readonly T[],
  control: ControlState | undefined,
  enabled?: Record<string, boolean>,
): { kept: T[]; skipped: { id: string; reason: string }[] } {
  const kept: T[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const p of plugins) {
    // 未启用的插件不参与装配，也不该产生「控制权不匹配」告警。
    if (enabled && enabled[p.manifest.id] !== true) continue
    const reason = ownershipProblem(p.manifest.owns, control)
    if (reason) skipped.push({ id: p.manifest.id, reason })
    else kept.push(p)
  }
  return { kept, skipped }
}
