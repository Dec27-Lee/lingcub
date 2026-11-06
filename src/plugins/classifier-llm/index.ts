/**
 * 消息分类器：一次 headless 调用，不常驻。
 *
 * 「模型只做分类，路由代码查表」——这里只回答「这是什么、值不值得做、大概属于哪个项目」，
 * 输出结构化 JSON；用哪个执行器、哪个目录由 routing/resolve 查配置决定。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Classifier, PluginContext } from '../../domain/ports.ts'
import type { Intent, ProjectCandidate } from '../../domain/types.ts'
import { extractJson } from '../../plugin-kit/json.ts'
import { runOnce } from '../../plugin-kit/spawn.ts'

const IntentSchema = z.object({
  kind: z.enum(['dev-request', 'bug', 'question', 'chatter', 'doc-update', 'todo']),
  topic: z.string().min(1),
  project: z.string().optional(),
  suggestedAction: z.enum(['dispatch_session', 'reply_only', 'update_doc', 'create_todo']),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
})

export const manifest = {
  id: 'classifier-llm',
  kind: 'classifier' as const,
  config: z.object({
    binary: z.string().default('dsh'),
    /** 一次性调用：`dsh --profile headless --json -` 从 stdin 读任务 */
    args: z.array(z.string()).default(['--profile', 'headless', '--json', '-']),
    prompt: z.string().default('prompts/classify.md'),
    minConfidence: z.number().min(0).max(1).default(0.3),
    timeoutMs: z.number().int().positive().default(180_000),
  }),
}

/** 从 headless 输出里抽出 Intent JSON；抽不到或不合 schema 一律 null（只记录，不派工）。 */
export function parseClassifierOutput(stdout: string): unknown {
  return extractJson(stdout)
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  const cfg = ctx.config
  let promptCache: string | null = null

  const classifier: Classifier = {
    async classify(e, candidates: readonly ProjectCandidate[]): Promise<Intent | null> {
      promptCache ??= readFileSync(resolve(cfg.prompt), 'utf8')
      const task = [
        promptCache,
        '',
        '## 候选项目（project 只能填这里的 id，或留空）',
        ...candidates.map((c) => `- ${c.id}：${c.name}（别名：${c.aliases.join('、') || '无'}）`),
        '',
        '## 消息',
        `来源：${e.source} / ${e.channel.kind} ${e.channel.name ?? e.channel.id}`,
        `发言人：${e.actor.name ?? e.actor.id}`,
        `时间：${e.occurredAt}`,
        '',
        e.text.trim() || '(空)',
      ].join('\n')

      const r = await runOnce({
        binary: cfg.binary,
        args: cfg.args,
        input: task,
        timeoutMs: cfg.timeoutMs,
      })
      if (r.code !== 0) {
        ctx.log('warn', `分类调用退出码 ${r.code}：${r.stderr.trim().slice(0, 300)}`)
        if (!r.stdout.trim()) return null
      }

      const parsed = IntentSchema.safeParse(parseClassifierOutput(r.stdout))
      if (!parsed.success) {
        ctx.log('warn', `分类输出不可用：${r.stdout.trim().slice(0, 300)}`)
        return null
      }
      const d = parsed.data
      const project = candidates.some((c) => c.id === d.project) ? d.project : undefined
      if (d.project && !project) ctx.log('warn', `模型给了表外项目 ${d.project}，已清空`)

      return {
        eventId: e.id,
        kind: d.kind,
        topic: d.topic,
        project,
        suggestedAction: d.suggestedAction,
        rationale: d.rationale,
        confidence: d.confidence,
      }
    },
  }

  ctx.register(classifier)
}
