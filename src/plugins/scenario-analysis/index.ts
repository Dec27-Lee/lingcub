/**
 * 平台中间层分析服务：所有渠道的 message.received 都先在这里补上下文、做一次 AI 分析，
 * 再发出 message.analyzed；下游（飞书分发、派工、日报……）只消费分析结果。
 *
 * 这里不写钉钉/飞书分支：渠道差异已经在 source 归一成 Event。
 */

import { z } from 'zod'
import { MESSAGE_ANALYZED } from '../../domain/events.ts'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event, MessageAnalysis } from '../../domain/types.ts'

interface HistoryItem {
  id: string
  occurredAt: string
  actor: { id: string; name?: string }
  text: string
}

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-analysis',
  roles: ['scenario'],
  wants: [
    'ai.summarize',
    'state.history.fetch',
    'state.analysis.degraded',
    'state.analysis.backlog',
    'state.analysis.old',
  ],
  on: ['message.received'],
  config: z
    .object({
      historyLimit: z.number().int().positive().max(100).default(20),
      /** 同时最多跑几个模型调用，防止消息洪峰拉起一堆 CLI */
      maxInFlight: z.number().int().positive().max(8).default(2),
      /** 崩溃/重启后补扫没有 message.analyzed 的消息 */
      sweepIntervalMs: z.number().int().positive().default(30_000),
      sweepLimit: z.number().int().positive().max(100).default(20),
      sweepLookbackMinutes: z.number().positive().max(24 * 60).default(10),
      /** 降级后按补扫节奏最多再试几次；达到上限就保留 degraded 供追踪。 */
      retryDegraded: z.boolean().default(true),
      maxAttempts: z.number().int().positive().max(5).default(2),
      /** >0 时启动后对窗口外缺口做一次受控补分析；默认关闭，避免旧卡重发 */
      backfillLimit: z.number().int().nonnegative().max(100).default(0),
      backfillBeforeMinutes: z.number().positive().max(24 * 60).default(60),
      /** 可选的来源白名单；留空=所有渠道 */
      sources: z.array(z.string()).default([]),
    })
    .strict(),
}

let sweepTimer: NodeJS.Timeout | null = null
let stopped = false
let stopping = false
let activeAnalyses = 0

export function analysisEventId(eventId: string, attempt = 1): string {
  return attempt <= 1 ? `analysis:${eventId}` : `analysis:${eventId}:r${attempt - 1}`
}

export function setup(ctx: PluginContextV2): void {
  stopped = false
  stopping = false
  activeAnalyses = 0
  const cfg = ctx.config as {
    historyLimit: number
    maxInFlight: number
    sweepIntervalMs: number
    sweepLimit: number
    sweepLookbackMinutes: number
    retryDegraded: boolean
    maxAttempts: number
    backfillLimit: number
    backfillBeforeMinutes: number
    sources: string[]
  }
  let active = 0
  const waiting: (() => void)[] = []
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < cfg.maxInFlight) {
        active++
        resolve()
      } else {
        waiting.push(resolve)
      }
    })
  const release = (): void => {
    const next = waiting.shift()
    if (next) next()
    else active--
  }

  const inFlight = new Set<string>()
  const emitAnalysis = (event: Event, analysis: MessageAnalysis): void => {
    const attempt = analysis.attempt ?? 1
    if (stopped) {
      ctx.log('warn', `分析已停止，丢弃未写事件 ${event.id} attempt=${attempt}`)
      return
    }
    // 原始载荷已经存在 events.raw；分析事件不再复制一份，避免事件史翻倍。
    const safeEvent = { ...event, raw: undefined }
    try {
      ctx.emit(MESSAGE_ANALYZED, { event: safeEvent, analysis }, {
        id: analysisEventId(event.id, attempt),
        subject: event.channel.id,
        causedBy: event.id,
      })
    } catch (err) {
      ctx.log('error', `写 message.analyzed 失败 ${event.id}：${err instanceof Error ? err.message : String(err)}`)
    }
    ctx.log(
      analysis.status === 'ok' ? 'info' : 'warn',
      `分析 ${event.id} attempt=${attempt} origin=${analysis.origin ?? 'live'} status=${analysis.status} context=${analysis.contextCount} summary=${analysis.summary || '(空)'}`,
    )
  }

  const runAnalysis = (event: Event, attempt = 1, origin: 'live' | 'backfill' = 'live'): void => {
    if (stopped || stopping) return
    if (inFlight.has(event.id)) return
    if (cfg.sources.length && !cfg.sources.includes(event.source)) return
    inFlight.add(event.id)
    activeAnalyses++
    void (async () => {
      const at = new Date().toISOString()
      const startedAt = Date.now()
      if (!ctx.has('ai.summarize') || !ctx.has('state.history.fetch')) {
        emitAnalysis(event, {
          eventId: event.id,
          attempt,
          origin,
          summary: '',
          status: 'degraded',
          contextCount: 0,
          latencyMs: Date.now() - startedAt,
          error: '缺少 ai.summarize 或 state.history.fetch',
          at,
        })
        activeAnalyses--
        inFlight.delete(event.id)
        return
      }

      let history: HistoryItem[] = []
      let contextVia: MessageAnalysis['contextVia']
      await acquire()
      try {
        try {
          const fetched = await ctx.call<{
            items: { externalId: string; occurredAt: string; actor: { id: string; name?: string }; text: string }[]
            complete: boolean
            via: 'event-store' | 'source-history'
          }>('state.history.fetch', {
            source: event.source,
            channelId: event.channel.id,
            before: event.receivedAt,
            limit: cfg.historyLimit,
          })
          contextVia = fetched.via
          history = fetched.items.map((h) => ({
            id: h.externalId,
            occurredAt: h.occurredAt,
            actor: h.actor,
            text: h.text,
          }))
          ctx.log('info', `历史 ${event.channel.id} via=${fetched.via} complete=${fetched.complete} count=${history.length}`)
        } catch (err) {
          ctx.log('warn', `读取会话历史失败 ${event.channel.id}：${err instanceof Error ? err.message : String(err)}`)
        }
        const result = await ctx.call<{
          summary: string
          urgency?: 'low' | 'normal' | 'high'
          entities?: string[]
          model: string
        }>('ai.summarize', {
          event,
          history,
        })
        emitAnalysis(event, {
          eventId: event.id,
          attempt,
          origin,
          summary: result.summary,
          urgency: result.urgency,
          entities: result.entities,
          status: 'ok',
          model: result.model,
          contextCount: history.length,
          contextVia,
          latencyMs: Date.now() - startedAt,
          at,
        })
      } catch (err) {
        emitAnalysis(event, {
          eventId: event.id,
          attempt,
          origin,
          summary: '',
          status: 'degraded',
          contextCount: history.length,
          contextVia,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
          at,
        })
      } finally {
        inFlight.delete(event.id)
        activeAnalyses--
        release()
      }
    })()
  }

  ctx.on('message.received', (e) => {
    runAnalysis(e.payload as Event)
  })

  const sweep = async (): Promise<void> => {
    if (!ctx.has('state.analysis.pending')) return
    try {
      const rows = await ctx.call<Event[]>('state.analysis.pending', {
        limit: cfg.sweepLimit,
        sinceMinutes: cfg.sweepLookbackMinutes,
      })
      for (const row of rows) runAnalysis(row)
      if (cfg.retryDegraded && ctx.has('state.analysis.degraded')) {
        const degraded = await ctx.call<
          { event: Event; analysis: MessageAnalysis; analysisEventId: string }[]
        >('state.analysis.degraded', {
          limit: cfg.sweepLimit,
          sinceMinutes: cfg.sweepLookbackMinutes,
        })
        for (const row of degraded) {
          const used = row.analysis.attempt ?? 1
          if (used < cfg.maxAttempts) runAnalysis(row.event, used + 1)
        }
      }
    } catch (err) {
      ctx.log('warn', `分析补扫失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const reportBacklog = async (): Promise<void> => {
    if (!ctx.has('state.analysis.backlog')) return
    try {
      const r = await ctx.call<{ count: number }>('state.analysis.backlog', {
        beforeMinutes: cfg.sweepLookbackMinutes,
      })
      if (r.count > 0) {
        ctx.log(
          'warn',
          `存在 ${r.count} 条早于补扫窗口且无分析的消息；设置 backfillLimit 后重启可受控补分析`,
        )
      }
    } catch (err) {
      ctx.log('warn', `分析缺口统计失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const backfill = async (): Promise<void> => {
    if (cfg.backfillLimit <= 0) return
    if (!ctx.has('state.analysis.old')) return
    try {
      const rows = await ctx.call<Event[]>('state.analysis.old', {
        limit: cfg.backfillLimit,
        beforeMinutes: cfg.backfillBeforeMinutes,
      })
      for (const row of rows) runAnalysis(row, 1, 'backfill')
      if (rows.length) ctx.log('info', `backfill 启动 ${rows.length} 条历史消息分析，分发副作用抑制`)
    } catch (err) {
      ctx.log('warn', `backfill 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 首次补扫稍后执行，之后按间隔补扫；unref 不阻止进程退出。
  setTimeout(() => void sweep(), 2_000).unref()
  setTimeout(() => void reportBacklog(), 1_500).unref()
  setTimeout(() => void backfill(), 2_500).unref()
  sweepTimer = setInterval(() => void sweep(), cfg.sweepIntervalMs)
  sweepTimer.unref()
}

export async function stop(_ctx: PluginContextV2): Promise<void> {
  stopping = true
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  const deadline = Date.now() + 5_000
  while (activeAnalyses > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  stopped = true
}
