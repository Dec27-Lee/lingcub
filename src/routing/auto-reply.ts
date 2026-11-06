/**
 * 自动回复策略（纯函数，不碰文件不碰网络——参考项目 policy.js 的同款判据）。
 *
 * 一条策略 = **一句自动回复 + 一组触发条件**，任意条件命中就发这句话；
 * 策略从上往下扫、先命中的生效，同一策略内的条件也从上往下。
 *
 * 时机只有两种：
 *   stopped：这一轮结束了，可带 afterSeconds（「安静太久」就是 stopped + 900，不填 = 一结束就判）
 *   busy：还在跑且已跑满 busySeconds
 * 比对可选、逐行自带方式：prefix / contains / regex（大小写不敏感，正则写错当作不命中）；
 * 整组留空就只看时机。
 */

export type MatchMode = 'prefix' | 'contains' | 'regex'

export interface MatchItem {
  mode: MatchMode
  text: string
}

export interface Trigger {
  when: 'stopped' | 'busy'
  /** 结束后再等这么多秒才判（0/不填 = 一结束就判） */
  afterSeconds?: number
  /** busy 时：已经跑了这么多秒 */
  busySeconds?: number
  match?: MatchItem[]
}

export interface Policy {
  reply: string
  enabled?: boolean
  triggers: Trigger[]
}

/** 采集到的会话事实 */
export interface Facts {
  /** 本轮最后一句助手正文 */
  text?: string
  busy: boolean
  /** 安静了多久（本轮结束后经过的秒数） */
  idleSeconds?: number
  /** 这一轮跑了多久 */
  busySeconds?: number
}

export interface Decision {
  reply: string
  why: string
  policyIndex: number
  triggerIndex: number
}

const norm = (t: string): string => t.replace(/\r\n/g, '\n').trim()

function textMatches(trigger: Trigger, text: string | undefined): boolean {
  const items = trigger.match ?? []
  if (!items.length) return true // 不填匹配文本 = 这类时机一律触发
  const t = norm(text ?? '')
  if (!t) return false
  return items.some(({ mode, text: m }) => {
    const hay = t.toLowerCase()
    const needle = m.toLowerCase()
    if (mode === 'prefix') return hay.startsWith(needle)
    if (mode === 'contains') return hay.includes(needle)
    try {
      return new RegExp(m).test(t)
    } catch {
      return false // 正则写错当作不命中，别卡住其他条件
    }
  })
}

function describe(trigger: Trigger): string {
  const items = trigger.match ?? []
  if (!items.length) return '不限内容'
  return items.map((m) => `${m.mode}:${m.text}`).join(' 或 ')
}

/** 单个条件是否命中；不命中返回 null（而不是 false，方便带出命中原因）。 */
export function triggerHits(trigger: Trigger, f: Facts): string | null {
  const when = trigger.when ?? 'stopped'

  if (when === 'stopped') {
    if (f.busy) return null // 正在跑的一轮不算「停下」
    const need = Number(trigger.afterSeconds) || 0
    // 只在要求等的时候才看时间：need=0 时不该被「安静 0 秒」这种边界挡掉
    if (need > 0 && !(Number(f.idleSeconds ?? -1) >= need)) return null
    if (!textMatches(trigger, f.text)) return null
    return need > 0
      ? `本轮已结束并安静 ${Math.round(Number(f.idleSeconds ?? 0))} 秒（${describe(trigger)}）`
      : `本轮已结束（${describe(trigger)}）`
  }

  // busy：还在跑且跑得够久——消息会进窗口输入队列，等这一轮结束就接上，不打断
  const need = Number(trigger.busySeconds) || 0
  if (!f.busy) return null
  if (!(Number(f.busySeconds ?? -1) >= need)) return null
  if (!textMatches(trigger, f.text)) return null
  return `已跑 ${Math.round(Number(f.busySeconds ?? 0))} 秒（${describe(trigger)}）`
}

/** 选出该发的那一句；没有命中返回 null。 */
export function decideAutoReply(policies: readonly Policy[] | undefined, facts: Facts): Decision | null {
  const list = policies ?? []
  for (let pi = 0; pi < list.length; pi++) {
    const p = list[pi]!
    if (p.enabled === false) continue // 关掉的策略永不触发
    for (let ti = 0; ti < p.triggers.length; ti++) {
      const why = triggerHits(p.triggers[ti]!, facts)
      if (why) return { reply: p.reply, why, policyIndex: pi, triggerIndex: ti }
    }
  }
  return null
}

/** 校验一条策略；返回问题描述或 null。写错的策略要能报出来，不能悄悄不生效。 */
export function policyProblem(p: Policy): string | null {
  if (!p.reply?.trim()) return '自动回复内容不能为空'
  if (!Array.isArray(p.triggers) || !p.triggers.length) return '至少要配一个触发条件'
  for (let i = 0; i < p.triggers.length; i++) {
    const t = p.triggers[i]!
    if (t.when !== 'stopped' && t.when !== 'busy') return `第 ${i + 1} 个触发条件：when 只能是 stopped 或 busy`
    if (t.when === 'busy' && (t.match?.length ?? 0) > 0) {
      // 这一轮还没结束，手边只有上一轮最后一句，按它比对是错的语义
      return `第 ${i + 1} 个触发条件：busy 时不能填比对文本`
    }
  }
  return null
}
