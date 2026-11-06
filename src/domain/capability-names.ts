/** 能力命名与效果家族的规则。纯函数，内核与插件校验共用。 */

import type { CapabilityEffect } from './events.ts'

/** 内核按名字家族确定效果；插件不能把副作用能力声明成 none。 */
export const EFFECT_FAMILIES: readonly { prefix: string; effect: CapabilityEffect }[] = [
  { prefix: 'session.', effect: 'session' },
  { prefix: 'notify.', effect: 'message' },
  { prefix: 'transport.', effect: 'message' },
  { prefix: 'doc.', effect: 'doc' },
  { prefix: 'task.', effect: 'task' },
]

/** 只有内核能提供的能力前缀。 */
export const KERNEL_CAPABILITY_PREFIXES: readonly string[] = [
  'event.',
  'state.',
  'session.',
  'notify.',
  'judge.',
  'policy.',
  'task.',
  'workspace.',
  'doc.',
]

export function effectOfName(name: string): CapabilityEffect | null {
  return EFFECT_FAMILIES.find((f) => name.startsWith(f.prefix))?.effect ?? null
}

export function isKernelCapability(name: string): boolean {
  return KERNEL_CAPABILITY_PREFIXES.some((p) => name.startsWith(p))
}

/** `channel-feishu` -> `feishu`；`scenario-dev-dispatch` -> `dev-dispatch`。 */
export function pluginSlug(pluginId: string): string {
  return pluginId.replace(/^(channel|source|executor|classifier|scenario|capability)-/, '')
}

/** 插件能力的完整校验；返回问题描述，合法返回 null。 */
export function pluginCapabilityProblem(
  pluginId: string,
  name: string,
  effect: CapabilityEffect,
): string | null {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) {
    return `能力名不合法（要求两段以上小写/数字/短横线）：${name}`
  }
  if (isKernelCapability(name)) return `插件 ${pluginId} 不能注册内核保留能力：${name}`
  const family = effectOfName(name)
  if (family && family !== effect) {
    return `能力 ${name} 属于 ${family} 家族，效果必须是 ${family}，不能声明为 ${effect}`
  }
  if (!family && effect !== 'none') return `能力 ${name} 不在效果家族内，只能是 effect=none`
  const slug = pluginSlug(pluginId)
  const allowed = [`${slug}.`, `transport.${slug}.`, `doc.${slug}.`]
  if (!allowed.some((p) => name.startsWith(p))) {
    return `能力 ${name} 必须以 ${allowed.join(' 或 ')} 开头（插件 ${pluginId}）`
  }
  return null
}
