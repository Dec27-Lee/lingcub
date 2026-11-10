/**
 * 重点私聊：多窗口并行时不再逐条转播，只把「要你管的」和「做完了」发到私聊。
 *
 * 三类来源（全部来自已有事件，不新增判定模型）：
 *   1. `session.ask.requested` / `session.permission.requested` —— 窗口在等你决策
 *   2. `session.turn.ended` —— 一个窗口这一轮跑完了
 *   3. `session.open.failed` —— 开窗失败（用户点了按钮却没起来，必须告诉他）
 *
 * 收件人只从配置来（`dmChatId`，p2p 会话 id），不猜、不从消息里推断。
 * 去重靠发件箱 dedupeKey：同会话同类型同桶只发一条。
 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Session } from '../../domain/types.ts'
import { extractJson } from '../../plugin-kit/json.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-focus-dm',
  roles: ['scenario'],
  on: ['session.ask.requested', 'session.permission.requested', 'session.turn.ended', 'session.open.failed'],
  wants: ['state.session.get', 'notify.card.send', 'notify.dm.send'],
  config: z
    .object({
      /** 私聊会话 id（oc_…，p2p）；空 = 不启用 */
      dmChatId: z.string().default(''),
      /** 按人私聊（open_id ou_…）；填了优先用它，省掉「先拿 p2p 会话 id」这一步 */
      dmUserId: z.string().default(''),
      /** 阶段一先只发「等你决策」，跑完的总结默认关（不然 5 个窗口能刷屏） */
      notifyOnAsk: z.boolean().default(true),
      notifyOnTurnEnd: z.boolean().default(false),
      notifyOnOpenFailed: z.boolean().default(true),
      /** 同一会话同一类型的去重桶（分钟） */
      dedupeMinutes: z.number().int().positive().default(10),
      maxChars: z.number().int().positive().max(300).default(120),
      /** 多窗口聚合窗口：这么短时间内的多个「等你决策」合成一条私聊 */
      batchMs: z.number().int().nonnegative().default(1200),
    })
    .strict(),
}

function card(title: string, template: string, lines: string[]): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements: [{ tag: 'markdown', content: lines.filter(Boolean).join('\n') }],
  }
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

/**
 * 分析器回执的结构化字段。
 *
 * 窗口里跑的如果是「渠道消息分析」，回复体就是一段 JSON。原来照原文贴出来，
 * 私聊里看到的是 `{"summary":"…","urgency":"normal",…}` —— 等于没渲染。
 * points/need/context 是本轮新增的分析字段，旧回执只有 summary/urgency/entities 也能认。
 */
const AnalysisPayloadSchema = z.object({
  summary: z.string().min(1),
  urgency: z.enum(['low', 'normal', 'high']).optional(),
  entities: z.array(z.string().min(1)).max(8).optional(),
  points: z.array(z.string().min(1)).max(5).optional(),
  need: z.string().optional(),
  context: z.string().optional(),
})

export type AnalysisPayload = z.infer<typeof AnalysisPayloadSchema>

/** 回复体是不是分析器 JSON；是就返回结构化字段，不是返回 undefined（走普通摘要）。 */
export function parseAnalysisPayload(text: string): AnalysisPayload | undefined {
  const raw = String(text || '').trim()
  if (!raw || !raw.includes('{')) return undefined
  const parsed = AnalysisPayloadSchema.safeParse(extractJson(raw))
  if (!parsed.success) return undefined
  const summary = parsed.data.summary.replace(/\s+/g, ' ').trim()
  if (!summary) return undefined
  const clean = (v: string | undefined): string | undefined => {
    const t = (v ?? '').replace(/\s+/g, ' ').trim()
    return t || undefined
  }
  return {
    summary,
    urgency: parsed.data.urgency,
    entities: parsed.data.entities?.map((x) => x.trim()).filter(Boolean),
    points: parsed.data.points?.map((x) => x.trim()).filter(Boolean),
    need: clean(parsed.data.need),
    context: clean(parsed.data.context),
  }
}

const URGENCY: Record<NonNullable<AnalysisPayload['urgency']>, { icon: string; template: string }> = {
  high: { icon: '🔴', template: 'red' },
  normal: { icon: '✅', template: 'green' },
  low: { icon: '⚪️', template: 'grey' },
}

/**
 * 分析回执卡片：给人看的形态，不是 JSON。
 *
 * 标题 = 窗口名（颜色和图标表达紧急度）；正文三段：结论 → 关键点 → 需要你；
 * 灰色页脚放与前文的关系、实体、工作区和「怎么继续」。
 */
export function buildTurnCard(opts: { title: string; analysis: AnalysisPayload; workspace?: string }): unknown {
  const a = opts.analysis
  const u = URGENCY[a.urgency ?? 'normal']
  const main: string[] = [`**${a.summary}**`]
  if (a.points?.length) main.push('', ...a.points.map((p) => `· ${p}`))
  if (a.need && !/^(无|无需|不需要)/.test(a.need)) main.push('', `👉 **需要你**：${a.need}`)
  const foot: string[] = []
  if (a.context) foot.push(`↗ 跟前文：${a.context}`)
  if (a.entities?.length) foot.push(`🏷 ${a.entities.join(' · ')}`)
  if (opts.workspace) foot.push(`📁 \`${opts.workspace}\``)
  foot.push('↩︎ 在这个窗口的话题里直接回复即可继续。')
  return {
    config: { wide_screen_mode: true },
    header: { template: u.template, title: { tag: 'plain_text', content: `${u.icon} ${opts.title}` } },
    elements: [
      { tag: 'markdown', content: main.join('\n') },
      // 每行单独包：飞书的行内标签不跨行，整段包住时颜色会失效
      { tag: 'markdown', content: foot.map((line) => `<font color='grey'>${line}</font>`).join('\n') },
    ],
  }
}

/**
 * 私聊摘要：手机上一眼能读完，且**不把句子截断**。
 *
 * 之前的做法是硬截 120 字，正文常常断在「…Mess…」这种地方，等于没有信息。
 * 现在按「标题 → 结论 → 要点 → 去哪看全文」组织：
 *   - 去掉 markdown 的 # / 多余空行，保留行内代码；
 *   - 取首句当结论（句号/问号/换行处收口，找不到合适断点才硬截）；
 *   - 后面最多再带 2 条要点（原文的列表行/小标题）。
 */
/** 卡片标题只放窗口名（太长会截），一眼知道是哪个窗口跑完了。 */
export function shortTitle(title: string, max = 24): string {
  const t = String(title || '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

export function summarizeReply(text: string, maxChars = 240): { lead: string; points: string[]; more: boolean } {
  const raw = String(text || '').replace(/\r/g, '')
  const lines = raw.split('\n').map((l) => ({ heading: /^\s{0,3}#{1,6}\s+/.test(l), text: l }))
  // 小标题（## xxx）不当结论用：它只是分组名，读了等于没读
  const stripMarkers = (s: string): string =>
    s.replace(/^\s*(?:[-*•]|\d+[.)、])\s+/, '').replace(/\*\*/g, '').trim()
  const bodyLines = lines.filter((l) => !l.heading).map((l) => stripMarkers(l.text)).filter((l) => l && l !== '---')
  const headingLines = lines.filter((l) => l.heading).map((l) => l.text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\*\*/g, '').trim()).filter(Boolean)
  const cleaned = bodyLines.length ? bodyLines : headingLines
  if (!cleaned.length) return { lead: '（这一轮没有输出）', points: [], more: false }

  const sentences = cleaned
    .join('\n')
    .split(/(?<=[。！？!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

  let lead = sentences[0] ?? ''
  if (lead.length > maxChars) lead = `${lead.slice(0, maxChars)}…`
  const points: string[] = []
  for (const s of sentences.slice(1)) {
    if (points.length >= 2) break
    if (lead.length + s.length + points.join('').length > maxChars) break
    points.push(s.length > 80 ? `${s.slice(0, 80)}…` : s)
  }
  const consumed = 1 + points.length
  return { lead, points, more: sentences.length > consumed }
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as {
    dmChatId: string
    dmUserId: string
    notifyOnAsk: boolean
    notifyOnTurnEnd: boolean
    notifyOnOpenFailed: boolean
    dedupeMinutes: number
    maxChars: number
    batchMs: number
  }

  const bucket = (): string => String(Math.floor(Date.now() / (cfg.dedupeMinutes * 60_000)))

  const send = async (key: string, body: unknown): Promise<void> => {
    if (cfg.dmUserId) {
      if (!ctx.has('notify.dm.send')) return
      await ctx.submit('notify.dm.send', { userId: cfg.dmUserId, card: body }, `${key}:${bucket()}`)
      ctx.log('info', `重点私聊 → ${cfg.dmUserId}（${key}）`)
      return
    }
    if (!cfg.dmChatId) return
    if (!ctx.has('notify.card.send')) return
    await ctx.submit('notify.card.send', { chatId: cfg.dmChatId, card: body }, `${key}:${bucket()}`)
    ctx.log('info', `重点私聊 → 会话 ${cfg.dmChatId}（${key}）`)
  }

  const sessionOf = async (sessionId: string): Promise<Session | null> => {
    if (!ctx.has('state.session.get')) return null
    return await ctx.call<Session | null>('state.session.get', { sessionId })
  }

  // 多窗口聚合：同一小段时间里冒出来的「等你决策」不带一次性刷 N 条，攒成一条发。
  interface PendingAsk {
    sessionId: string
    title: string
    kind: 'ask' | 'perm'
    detail: string
  }
  const pending = new Map<string, PendingAsk>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = async (): Promise<void> => {
    flushTimer = null
    const items = [...pending.values()]
    pending.clear()
    if (!items.length) return
    if (items.length === 1) {
      const it = items[0]!
      await send(
        `${it.kind}:${it.sessionId}`,
        it.kind === 'ask'
          ? card('🙋 等你回答', 'orange', [`**${it.title}**`, clip(it.detail, cfg.maxChars), '在对应话题里回一句话或点卡片按钮即可。'])
          : card('🔐 等你授权', 'orange', [`**${it.title}**`, `要用工具：${it.detail}`, '去话题里回 1 允许 / 2 拒绝。']),
      )
      return
    }
    const lines = items.map((it) => `· **${it.title}** — ${clip(it.detail, Math.floor(cfg.maxChars / 2))}`)
    await send(
      `batch:${items.map((i) => i.sessionId).sort().join(',')}`,
      card(`🙋 ${items.length} 个窗口在等你`, 'orange', [...lines, '去各自话题里处理，或回 #status 看整体状态。']),
    )
  }

  const enqueue = (it: PendingAsk): void => {
    pending.set(it.sessionId, it)
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      void flush()
    }, cfg.batchMs)
    // 别让定时器把进程钉住
    if (typeof flushTimer === 'object' && 'unref' in flushTimer) flushTimer.unref()
  }

  ctx.on('session.ask.requested', async (e) => {
    if (!cfg.notifyOnAsk) return
    const p = e.payload as { sessionId?: string; question?: string; questions?: { question?: string }[] }
    if (!p.sessionId) return
    const s = await sessionOf(p.sessionId)
    const what = p.question ?? p.questions?.[0]?.question ?? '窗口在等你回答'
    enqueue({ sessionId: p.sessionId, title: s?.title ?? p.sessionId.slice(0, 8), kind: 'ask', detail: what })
    if (cfg.batchMs === 0) await flush()
  })

  ctx.on('session.permission.requested', async (e) => {
    if (!cfg.notifyOnAsk) return
    const p = e.payload as { sessionId?: string; toolName?: string }
    if (!p.sessionId) return
    const s = await sessionOf(p.sessionId)
    enqueue({ sessionId: p.sessionId, title: s?.title ?? p.sessionId.slice(0, 8), kind: 'perm', detail: p.toolName ?? '未知工具' })
    if (cfg.batchMs === 0) await flush()
  })

  ctx.on('session.turn.ended', async (e) => {
    if (!cfg.notifyOnTurnEnd) return
    const p = e.payload as { sessionId?: string; text?: string }
    if (!p.sessionId) return
    const s = await sessionOf(p.sessionId)
    const title = shortTitle(s?.title ?? p.sessionId.slice(0, 8))
    const analysis = parseAnalysisPayload(p.text ?? '')
    if (analysis) {
      await send(`turn:${p.sessionId}`, buildTurnCard({ title, analysis, workspace: s?.workspace }))
      return
    }
    const summary = summarizeReply(p.text ?? '', cfg.maxChars)
    await send(
      `turn:${p.sessionId}`,
      card(`✅ ${title}`, 'green', [
        summary.lead,
        ...summary.points.map((x) => `· ${x}`),
        summary.more ? '…（还有内容，进话题看全文）' : '',
        s?.workspace ? `📁 \`${s.workspace}\`` : '',
        '↩︎ 在这个窗口的话题里直接回复即可继续。',
      ]),
    )
  })

  ctx.on('session.open.failed', async (e) => {
    if (!cfg.notifyOnOpenFailed) return
    const p = e.payload as { requestId?: string; reason?: string }
    await send(
      `openfail:${p.requestId ?? 'x'}`,
      card('⚠️ 窗口没起来', 'red', [
        clip(p.reason ?? '未知原因', cfg.maxChars),
        '去话题里回 #new 或直接再发一条任务重试。',
      ]),
    )
  })
}
