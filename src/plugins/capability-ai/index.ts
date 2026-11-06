/**
 * 平台中间层的 AI 分析能力：输入一条消息 + 同会话历史，输出一句中文摘要。
 *
 * 它不关心渠道是钉钉还是飞书；渠道由 source 归一成 Event，分发场景只读分析结果。
 * 模型走一次性 CLI（默认 claude），模型/命令/提示词都在 config 里换。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import { extractJson } from '../../plugin-kit/json.ts'
import { stripDwsMediaNotice } from '../../plugin-kit/dingtalk-text.ts'
import { runOnce } from '../../plugin-kit/spawn.ts'

const EventInput = z.object({
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  occurredAt: z.string(),
  actor: z.object({ id: z.string(), name: z.string().optional() }),
  channel: z.object({ kind: z.string(), id: z.string(), name: z.string().optional() }),
  text: z.string(),
})

const HistoryInput = z.object({
  id: z.string(),
  occurredAt: z.string(),
  actor: z.object({ id: z.string(), name: z.string().optional() }),
  text: z.string(),
})

const ConfigSchema = z
  .object({
    binary: z.string().default('claude'),
    /** 一次性调用；prompt 走 stdin，不塞命令行 */
    args: z.array(z.string()).default(['-p', '--output-format', 'text']),
    prompt: z.string().default('prompts/summarize.md'),
    timeoutMs: z.number().int().positive().default(90_000),
    maxChars: z.number().int().positive().default(80),
  })
  .strict()

type Config = z.infer<typeof ConfigSchema>
type HistoryItem = z.infer<typeof HistoryInput>

function hhmm(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  return `${parts.find((p) => p.type === 'hour')?.value ?? ''}:${parts.find((p) => p.type === 'minute')?.value ?? ''}`
}

export function buildSummaryTask(event: z.infer<typeof EventInput>, history: HistoryItem[], persona: string): string {
  const lines = history.map(
    (h) => `[${hhmm(h.occurredAt)}] ${h.actor.name ?? h.actor.id}：${stripDwsMediaNotice(h.text) || '（空）'}`,
  )
  return [
    persona,
    '',
    '## 同一会话的最近聊天记录（从旧到新）',
    ...(lines.length ? lines : ['（没有历史消息）']),
    '',
    '## 当前消息',
    `发送人：${event.actor.name ?? event.actor.id}`,
    `会话：${event.channel.kind} ${event.channel.name ?? event.channel.id}`,
    `时间：${hhmm(event.occurredAt)}`,
    stripDwsMediaNotice(event.text) || '（空/媒体消息）',
  ].join('\n')
}

const AnalysisOutput = z.object({
  summary: z.string().min(1),
  urgency: z.enum(['low', 'normal', 'high']).optional(),
  entities: z.array(z.string().min(1)).max(5).optional(),
})

export function parseSummary(stdout: string, maxChars = 80): string | undefined {
  const raw = extractJson(stdout)
  const parsed = AnalysisOutput.safeParse(raw)
  if (!parsed.success) return undefined
  const text = parsed.data.summary.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

export function parseAnalysis(
  stdout: string,
  maxChars = 80,
): { summary: string; urgency?: 'low' | 'normal' | 'high'; entities?: string[] } | undefined {
  const summary = parseSummary(stdout, maxChars)
  const parsed = AnalysisOutput.safeParse(extractJson(stdout))
  if (!summary || !parsed.success) return undefined
  return {
    summary,
    urgency: parsed.data.urgency,
    entities: parsed.data.entities,
  }
}

export const manifest: ManifestV2 = {
  v: 2,
  id: 'capability-ai',
  roles: ['capability'],
  provides: [{ name: 'ai.summarize', effect: 'none' }],
  config: ConfigSchema,
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as Config
  let persona = ''

  ctx.provide(
    'ai.summarize',
    {
      input: z.object({
        event: EventInput,
        history: z.array(HistoryInput).default([]),
      }),
      output: z.object({
        summary: z.string(),
        urgency: z.enum(['low', 'normal', 'high']).optional(),
        entities: z.array(z.string()).optional(),
        model: z.string(),
      }),
      timeoutMs: cfg.timeoutMs,
    },
    async (input) => {
      persona ||= readFileSync(resolve(cfg.prompt), 'utf8')
      const task = buildSummaryTask(input.event, input.history ?? [], persona)
      const r = await runOnce({
        binary: cfg.binary,
        args: cfg.args,
        input: task,
        timeoutMs: cfg.timeoutMs,
      })
      if (r.code !== 0) {
        throw new Error(`摘要模型退出码 ${r.code ?? 'null'}：${r.stderr.trim().slice(0, 300)}`)
      }
      const analysis = parseAnalysis(r.stdout, cfg.maxChars)
      if (!analysis) throw new Error(`摘要模型输出无有效 JSON：${r.stdout.trim().slice(0, 300)}`)
      return { ...analysis, model: cfg.binary }
    },
  )
}
