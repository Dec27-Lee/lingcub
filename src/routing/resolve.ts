/** Intent → Work：代码查表，不问模型。工作区与执行器只认 config/。 */

import type { Event, Intent, Work } from '../domain/types.ts'
import type { Config, Projects, Workspace } from '../kernel/config.ts'
import { assertAllowedRoot } from '../kernel/config.ts'
import { workId } from '../kernel/ids.ts'

export interface ResolveContext {
  config: Config
  projects: Projects
}

export type ResolveResult =
  | { kind: 'work'; work: Work }
  /** observe 档：只记录，不产出 Work */
  | { kind: 'observe' }
  | { kind: 'skip'; reason: string }

/** auto 档自动入队的最低置信度；白名单即 projects.yaml 内的工作区。 */
export const AUTO_MIN_CONFIDENCE = 0.9

/** 项目名或别名 → 工作区。匹配不上返回 undefined，由调用方决定怎么问人。 */
export function findWorkspace(projects: Projects, project: string | undefined): Workspace | undefined {
  if (!project) return undefined
  const key = project.toLowerCase()
  return projects.workspaces.find(
    (w) => w.id.toLowerCase() === key || w.aliases.some((a) => a.toLowerCase() === key),
  )
}

const CHANNEL_LABEL: Readonly<Record<Event['channel']['kind'], string>> = {
  dm: '私聊',
  group: '群聊',
  doc: '文档',
  task: '待办',
}

function buildPrompt(intent: Intent, e: Event, ws: Workspace): string {
  const lines = [
    `# 任务：${intent.topic}`,
    '',
    `来源：${e.source} / ${CHANNEL_LABEL[e.channel.kind]} ${e.channel.name ?? e.channel.id}`,
    `发起人：${e.actor.name ?? e.actor.id}`,
    `发生时间：${e.occurredAt}`,
    '',
    '## 原文',
    '',
    e.text.trim() || '(空)',
    '',
    '## 工作区',
    '',
    `- 项目：${ws.name}（${ws.id}）`,
  ]
  if (ws.kind === 'umbrella') {
    lines.push(`- 伞形工作区：子仓库自行定位，动手前先读 ${ws.router ?? '仓库路由文件'}`)
  }
  lines.push('', '## 判断依据', '', intent.rationale)
  return lines.join('\n')
}

export function resolveWork(intent: Intent, e: Event, { config, projects }: ResolveContext): ResolveResult {
  if (intent.suggestedAction !== 'dispatch_session') {
    return { kind: 'skip', reason: `动作 ${intent.suggestedAction} 不需要执行器` }
  }
  // observe 档只记录：不解析工作区、不做门禁、不产出 Work。
  // suggest 档的 Work 由调用方转成「待确认」动作，不直接投给执行器。
  if (config.mode === 'observe') return { kind: 'observe' }

  const ws = findWorkspace(projects, intent.project)
  if (!ws) return { kind: 'skip', reason: `未匹配到工作区：${intent.project ?? '(空)'}` }

  const policy = config.executor_policies[ws.executor]
  if (!policy) throw new Error(`执行器 ${ws.executor} 在 executor_policies 里没有策略`)

  // 门禁：入队前拒绝，工作区根必须落在该执行器的 allowRoots 内。
  assertAllowedRoot(ws.root, policy.allowRoots)

  if (config.mode === 'auto' && intent.confidence < AUTO_MIN_CONFIDENCE) {
    return {
      kind: 'skip',
      reason: `auto 档要求置信度 ≥ ${AUTO_MIN_CONFIDENCE}，实为 ${intent.confidence}`,
    }
  }

  return {
    kind: 'work',
    work: {
      id: workId(intent.eventId),
      intentId: intent.eventId,
      kind: 'session',
      project: ws.id,
      executor: ws.executor,
      workspace: ws.root,
      prompt: buildPrompt(intent, e, ws),
      budgetUsd: policy.defaultBudgetUsd,
      status: 'queued',
    },
  }
}
