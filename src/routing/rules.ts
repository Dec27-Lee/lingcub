/** 确定性规则：命中直接产出 Intent，不调模型。按序求值，首个命中即停。 */

import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'
import type { ActionKind, Event, Intent, IntentKind } from '../domain/types.ts'
import { assertValid } from '../kernel/config.ts'

const INTENT_KINDS = ['dev-request', 'bug', 'question', 'chatter', 'doc-update', 'todo'] as const
const ACTION_KINDS = ['dispatch_session', 'reply_only', 'update_doc', 'create_todo'] as const

/** 谓词之间是 AND；未知键直接报错，避免拼错字段静默失效。 */
const PredicateSchema = z
  .object({
    channel: z.enum(['dm', 'group', 'doc', 'task']).optional(),
    atMe: z.boolean().optional(),
    groupIn: z.literal('allowlist').optional(),
    peopleIn: z.literal('allowlist').optional(),
    textMatches: z.string().min(1).optional(),
    always: z.literal(true).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: '规则至少要有一个谓词' })

const ThenSchema = z
  .object({
    kind: z.enum(INTENT_KINDS),
    suggestedAction: z.enum(ACTION_KINDS).optional(),
    project: z.string().min(1).optional(),
    topic: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

const RuleSchema = z.object({ id: z.string().min(1), when: PredicateSchema, then: ThenSchema }).strict()

const AllowlistSchema = z
  .object({
    groups: z.array(z.string()).default([]),
    people: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
  })
  .default({})

const RulesSchema = z.object({ rules: z.array(RuleSchema), allowlist: AllowlistSchema }).strict()

export type Predicate = z.infer<typeof PredicateSchema>
export type Rule = z.infer<typeof RuleSchema>
export type Allowlist = z.infer<typeof AllowlistSchema>

export interface Ruleset {
  readonly rules: readonly Rule[]
  readonly allowlist: Allowlist
}

/** Intent.kind 到建议动作的缺省映射；规则可用 then.suggestedAction 覆盖。 */
const DEFAULT_ACTION: Readonly<Record<IntentKind, ActionKind>> = {
  'dev-request': 'dispatch_session',
  bug: 'dispatch_session',
  question: 'reply_only',
  chatter: 'reply_only',
  'doc-update': 'update_doc',
  todo: 'create_todo',
}

export function loadRules(path: string): Ruleset {
  const data = assertValid(RulesSchema, parse(readFileSync(path, 'utf8')), path)
  const ids = new Set<string>()
  for (const rule of data.rules) {
    if (ids.has(rule.id)) throw new Error(`${path}: 规则 id 重复：${rule.id}`)
    ids.add(rule.id)
    const re = rule.when.textMatches
    if (re !== undefined) {
      try {
        new RegExp(re, 'i')
      } catch {
        throw new Error(`${path}: 规则 ${rule.id} 的 textMatches 不是合法正则：${re}`)
      }
    }
  }
  return { rules: data.rules, allowlist: data.allowlist }
}

function matches(p: Predicate, e: Event, allowlist: Allowlist): boolean {
  if (p.channel !== undefined && p.channel !== e.channel.kind) return false
  if (p.atMe !== undefined && (e.atMe ?? false) !== p.atMe) return false
  if (p.groupIn === 'allowlist' && !allowlist.groups.includes(e.channel.id)) return false
  if (p.peopleIn === 'allowlist' && !allowlist.people.includes(e.actor.id)) return false
  if (p.textMatches !== undefined && !new RegExp(p.textMatches, 'i').test(e.text)) return false
  return true
}

function summarize(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 60) : '(无正文)'
}

function toIntent(rule: Rule, e: Event): Intent {
  return {
    eventId: e.id,
    kind: rule.then.kind,
    topic: rule.then.topic ?? summarize(e.text),
    project: rule.then.project,
    suggestedAction: rule.then.suggestedAction ?? DEFAULT_ACTION[rule.then.kind],
    rationale: `规则 ${rule.id} 命中`,
    confidence: rule.then.confidence,
    byRule: rule.id,
  }
}

/** 首个命中即停：不叠加、不 fallthrough，避免多条规则组合出意外结论。 */
export function evaluate(rs: Ruleset, e: Event): Intent | null {
  for (const rule of rs.rules) {
    if (matches(rule.when, e, rs.allowlist)) return toIntent(rule, e)
  }
  return null
}
