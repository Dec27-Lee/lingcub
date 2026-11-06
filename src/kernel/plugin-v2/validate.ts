/** 清单 v2 校验：一次报全部问题；错误信息带字段路径，便于 doctor 直接打印。 */

import { z } from 'zod'
import { pluginCapabilityProblem } from '../../domain/capability-names.ts'
import type { CapabilityEffect } from '../../domain/events.ts'
import { PLUGIN_ROLES, type CapabilityDecl, type ManifestV2 } from '../../domain/plugin-v2.ts'

const MANIFEST_KEYS = new Set(['v', 'id', 'roles', 'provides', 'needs', 'wants', 'on', 'owns', 'activation', 'config'])
const PROVIDE_KEYS = new Set(['name', 'effect', 'input', 'output', 'timeoutMs'])
const ID_RE = /^(source|channel|executor|classifier|scenario|capability)-[a-z0-9-]+$/
const EFFECTS: readonly CapabilityEffect[] = ['none', 'message', 'session', 'doc', 'task']

export interface ManifestValidation {
  manifest?: ManifestV2
  problems: string[]
}

export function validateManifestV2(raw: unknown, dirName: string): ManifestValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problems: [`${dirName}: manifest 不是对象`] }
  }
  const m = raw as Record<string, unknown>
  const problems: string[] = []

  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(key)) problems.push(`未知键：${key}`)
  }
  if (m.v !== 2) problems.push(`v 必须是 2（当前 ${String(m.v)}）`)

  const id = m.id
  if (typeof id !== 'string' || !id) {
    problems.push('id 必须是非空字符串')
  } else {
    if (id !== dirName) problems.push(`id（${id}）必须等于目录名（${dirName}）`)
    if (!ID_RE.test(id)) {
      problems.push(`id 不合法：${id}（要求 <source|channel|executor|classifier|scenario|capability>-<小写/数字/短横线>）`)
    }
  }

  const roles = m.roles
  if (!Array.isArray(roles) || roles.length === 0) {
    problems.push('roles 必须是非空数组')
  } else {
    const seen = new Set<string>()
    for (const r of roles) {
      if (typeof r !== 'string' || !(PLUGIN_ROLES as readonly string[]).includes(r)) {
        problems.push(`未知角色：${String(r)}`)
      } else if (seen.has(r)) {
        problems.push(`roles 重复：${r}`)
      } else {
        seen.add(r)
      }
    }
  }

  const activation = m.activation
  if (activation !== undefined && activation !== 'restart' && activation !== 'hot') {
    problems.push(`activation 只能是 restart 或 hot（当前 ${String(activation)}）`)
  } else if (activation === 'hot') {
    const onlyCapability =
      Array.isArray(roles) &&
      roles.length === 1 &&
      roles[0] === 'capability' &&
      (!Array.isArray(m.on) || m.on.length === 0)
    if (!onlyCapability) problems.push('activation=hot 只允许无事件订阅的纯 capability 插件')
    if (Array.isArray(m.provides)) {
      for (const p of m.provides) {
        const effect = (p as { effect?: unknown } | null)?.effect
        if (effect !== undefined && effect !== 'none') problems.push('activation=hot 的能力必须是 effect=none')
      }
    }
  }

  const provides = Array.isArray(m.provides) ? m.provides : []
  if (m.provides !== undefined && !Array.isArray(m.provides)) problems.push('provides 必须是数组')
  const declared = new Set<string>()
  for (const [i, p] of provides.entries()) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      problems.push(`provides[${i}] 不是对象`)
      continue
    }
    const c = p as Record<string, unknown>
    for (const key of Object.keys(c)) {
      if (!PROVIDE_KEYS.has(key)) problems.push(`provides[${i}] 未知键：${key}`)
    }
    const name = c.name
    const effect = c.effect
    if (typeof name !== 'string' || !name) {
      problems.push(`provides[${i}].name 必须是非空字符串`)
      continue
    }
    if (declared.has(name)) problems.push(`provides 能力重复：${name}`)
    declared.add(name)
    if (typeof effect !== 'string' || !(EFFECTS as readonly string[]).includes(effect)) {
      problems.push(`provides[${i}].effect 不合法：${String(effect)}`)
      continue
    }
    if (typeof id === 'string') {
      const problem = pluginCapabilityProblem(id, name, effect as CapabilityEffect)
      if (problem) problems.push(problem)
    }
    if (c.input !== undefined && !isZod(c.input)) problems.push(`provides[${i}].input 必须是 zod schema`)
    if (c.output !== undefined && !isZod(c.output)) problems.push(`provides[${i}].output 必须是 zod schema`)
    if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== 'number' || c.timeoutMs <= 0)) {
      problems.push(`provides[${i}].timeoutMs 必须是正数`)
    }
  }

  const needs = stringList(m.needs, 'needs', problems)
  const wants = stringList(m.wants, 'wants', problems)
  for (const n of needs) {
    if (wants.includes(n)) problems.push(`能力不能同时在 needs 与 wants：${n}`)
    if (declared.has(n)) problems.push(`插件不能依赖自己提供的能力：${n}`)
  }
  for (const kind of stringList(m.on, 'on', problems)) {
    if (!kind.trim()) problems.push('on 不能包含空串')
  }

  if (!isZod(m.config)) problems.push('config 必须是 zod schema')

  if (problems.length) return { problems }
  return {
    manifest: {
      v: 2,
      id: id as string,
      roles: roles as ManifestV2['roles'],
      provides: provides as CapabilityDecl[],
      needs,
      wants,
      on: m.on as string[] | undefined,
      owns: m.owns as ManifestV2['owns'],
      activation: (m.activation as ManifestV2['activation']) ?? 'restart',
      config: m.config as z.ZodTypeAny,
    },
    problems: [],
  }
}

/** 校验并解析插件配置；v2 的对象 schema 会被强制 strict（拒绝未知键）。 */
export function parsePluginConfig(manifest: ManifestV2, raw: unknown): unknown {
  const schema =
    manifest.config instanceof z.ZodObject ? (manifest.config as z.ZodObject<z.ZodRawShape>).strict() : manifest.config
  const r = schema.safeParse(raw ?? {})
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`插件 ${manifest.id} 配置非法：\n  ${lines.join('\n  ')}`)
  }
  return r.data
}

function isZod(v: unknown): v is z.ZodTypeAny {
  return typeof (v as { safeParse?: unknown } | null)?.safeParse === 'function'
}

function stringList(v: unknown, label: string, problems: string[]): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) {
    problems.push(`${label} 必须是非空字符串数组`)
    return []
  }
  return v as string[]
}
