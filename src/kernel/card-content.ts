import { createHash } from 'node:crypto'
/**
 * 状态卡的内容（参考项目 status 插件的那几行）。
 * 纯函数：给会话 + 转录 + 时间，吐 CardState；渲染成飞书卡片由频道插件负责。
 */

import type { CardState, Session } from '../domain/types.ts'
import { currentTurn, lastUserInput, statsLine } from './transcript.ts'

export interface StatusInput {
  session: Session
  /** 转录文件；没有就只画能画的行 */
  transcript?: string
  now?: number
  contextWindow?: number
  /** 这一轮是否还在跑 */
  running: boolean
  /** 用量那一行的分母；不给就用 200k */
  maxLines?: number
}

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)

/**
 * 空闲计时**只到分钟**（参考项目 formatAgo）：精确到秒没有意义，
 * 而且这里的粒度直接决定发多少次请求——「59 秒前 → 1 分钟前」会让空闲窗口每秒刷新一次。
 */
export function formatAgo(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/**
 * 运行中计时（参考项目 formatElapsed）：两分钟以内 `m:ss`（看得出在动），
 * 再往上只到分钟——秒级刷新对谁都没用，只会把投递队列填满。
 */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 120) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/** 卡片上的文件只留最后两段（路径太长会把一行撑爆）。 */
function shortPath(p: string): string {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 2) return parts.join('/') || String(p || '')
  return `…/${parts.slice(-2).join('/')}`
}

/**
 * 行序与参考项目一致：
 *   💬 你说 / 🟢 正在运行·已 X（或 ⚪ 本轮结束·N 分钟前）
 *   ✏️ 本轮改了 N 个文件 / 🤖 它说 / 📁 目录 / 📦 用量
 * 取不到的项不写，不编数据。
 */
export function buildStatusCard(a: StatusInput): CardState {
  const now = a.now ?? Date.now()
  const turn = a.transcript ? currentTurn(a.transcript) : { files: [] as string[] }
  const lines: string[] = []

  // 💬 你说：只显示终端里打的（飞书发起的那些轮次没必要回显）
  const said = a.transcript ? lastUserInput(a.transcript) : null
  if (said) lines.push(`💬 你说：${clip(said.replace(/\s+/g, ' '), 80)}`)

  if (a.running) {
    const started = turn.startedAt ? Date.parse(turn.startedAt) : Date.parse(a.session.lastActiveAt)
    lines.push(`🟢 正在运行 · 已 ${formatClock(now - started)}`)
    // 正在用哪个工具，或者在想（没有工具就是模型在生成）
    lines.push(
      turn.tool
        ? `🔧 \`${turn.tool.name}\`${turn.tool.detail ? `：${clip(turn.tool.detail, 60)}` : ''}`
        : '🤔 正在思考…',
    )
    const running = turn.openSubtasks ?? []
    if (running.length) {
      lines.push(`🟡 另有 ${running.length} 个子任务在跑`)
      for (const sub of running.slice(0, 3)) lines.push(`🤖 \`${sub.name}\`：${sub.what || '（没说干啥）'}`)
    }
  } else {
    const lastAt = Date.parse(a.session.lastActiveAt)
    const subs = turn.openSubtasks ?? []
    if (subs.length) {
      // 主会话说完了，但它拉起来的活还在跑——这时候说「本轮结束」是骗人的
      lines.push(`🟡 本轮已回复，${subs.length} 个子任务还在跑 · 主会话 ${formatAgo(now - lastAt)}停下`)
      for (const sub of subs.slice(0, 3)) lines.push(`🤖 \`${sub.name}\`：${sub.what || '（没说干啥）'}`)
    } else {
      lines.push(`⚪ 本轮结束 · ${formatAgo(now - lastAt)}`)
    }
  }

  if (turn.files.length) {
    const files = turn.files.slice(0, 5).map((f) => `\`${shortPath(f)}\``).join('、')
    lines.push(`✏️ 本轮改了 ${turn.files.length} 个文件：${files}${turn.files.length > 5 ? ' 等' : ''}`)
  }
  if (turn.said) lines.push(`🤖 它说：${clip(turn.said.replace(/\s+/g, ' '), 140)}`)
  lines.push(`📁 \`${a.session.workspace}\``)

  const stats = statsLine(a.transcript, a.contextWindow ?? 200_000)
  if (stats) lines.push(`📦 ${stats}`)

  const max = a.maxLines ?? 9
  return {
    title: a.session.title ?? a.session.id,
    status: a.running ? 'running' : 'done',
    lines: lines.slice(0, max),
  }
}

/**
 * 卡片「内容签名」——用来判断要不要真的改卡。
 *
 * 状态卡里带「已 3 分 12 秒」这种秒级文案，每秒都不一样；直接拿整张卡做哈希，
 * 就会每 2 秒 patch 一次飞书（既有频率限制，也没意义）。所以签名前把秒级抖动抹平：
 * 秒数丢掉、分钟保留、小时级的分钟也丢掉。
 */
export function normalizeCardLine(line: string): string {
  return line
    .replace(/(\d+)\s*分\s*\d+\s*秒/g, '$1 分')
    .replace(/\d+\s*秒/g, '')
    .replace(/(\d+)\s*小时\s*\d+\s*分/g, '$1 小时')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 状态卡的「要不要改卡」判据（发件箱判重与入队签名都走它）。
 *
 * 为什么不能直接哈希整张卡：卡里有「18 分 57 秒前」这种秒级文案，直接哈希 →
 * 每 5 秒一个新签名 → 每 5 秒 patch 一次飞书；实测把投递队列堵死，
 * 用户那条回复排在后面要等半分钟。所以先抹平秒级抖动再哈希。
 */
export function stableCardSignature(card: CardState): string {
  const normalized = { ...card, lines: card.lines.map(normalizeCardLine) }
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)
}

/** 入队与判重共用的状态卡签名（语义同 stableCardSignature，名字更贴调用处）。 */
export const statusCardSignature = stableCardSignature
