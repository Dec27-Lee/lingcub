/**
 * 在场探测（只读采样文件）。
 *
 * 为什么需要：选择题与工具授权的钩子一旦拦下来，终端弹窗就不会渲染，整轮阻塞等人从手机上答。
 * 人在电脑前时应当**不拦**，让弹窗照常出现。
 *
 * 采样由平台层做（每秒写一次 `data/presence.json`），内核只读文件——毫秒级，适合钩子高频调用。
 * 没有采样器（本机未部署）时恒返回 null，判定一律退到「不在」，也就是永远推卡片：
 * 功能不缺失，只是手机上会多收几张卡。探测失败一律 fail-open，绝不让人白等。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Presence {
  idleMs: number
  locked: boolean
  /** 采样时间（ISO） */
  at: string
}

/** 超过这个时间就认为采样停了，不能拿旧数据当现状 */
const STALE_MS = 15_000
/** 空闲超过这个时长算「不在电脑前」（参考项目 awayIdleSeconds=180，设计文档也写 3 分钟） */
const AWAY_IDLE_MS = 180_000

export function presencePath(root: string): string {
  return resolve(root, 'data/presence.json')
}

export function readPresence(root: string): Presence | null {
  const file = presencePath(root)
  if (!existsSync(file)) return null
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Presence>
    if (typeof v.idleMs !== 'number' || typeof v.at !== 'string') return null
    if (Date.now() - Date.parse(v.at) > STALE_MS) return null
    return { idleMs: v.idleMs, locked: Boolean(v.locked), at: v.at }
  } catch {
    return null
  }
}

/** 人在电脑前吗？读不到就当不在（于是照常推卡片，不会让人干等）。 */
export function isPresent(root: string): boolean {
  const p = readPresence(root)
  if (!p) return false
  return !p.locked && p.idleMs < AWAY_IDLE_MS
}
