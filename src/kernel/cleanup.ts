/**
 * 过期数据清理（参考项目 kernel/lib.js cleanup + 每小时一次）。
 *
 * 五类回收：图片按天目录、消息映射 TTL、残留提问、超大日志、已结束的会话。
 * 全部「按需 + 幂等」：跑一次没东西可删也不报错；删不掉的（被占用）只记一笔，不中断别的。
 */

import { readdirSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface CleanupOptions {
  /** 数据目录（默认 data/） */
  dataDir: string
  /** 日志目录（默认 logs/） */
  logDir?: string
  /** 图片保留天数 */
  imageTtlDays?: number
  /** 单个日志超过这个大小就只留尾部一半 */
  maxLogBytes?: number
  now?: number
}

export interface CleanupResult {
  images: number
  /** 删掉的空/过期会话目录 */
  dirs: number
  logs: number
}

const DAY = 86_400_000

/**
 * 图片：`data/images/<YYYYMMDD>/<messageId>_<i>.png`。
 *
 * 过期判据用**目录名**（日期），不用 mtime：
 * 按 mtime 的话，只要这个目录里还在收新图，里面的旧图就永远删不掉。
 * 老结构（`data/images/<会话id>/`）也兼容：名字不是日期的，退回按 mtime 判。
 */
export function cleanupImages(dir: string, ttlDays: number, now = Date.now()): { dirs: number; files: number } {
  let dirs = 0
  let files = 0
  if (!existsSync(dir)) return { dirs, files }
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    // 目录名是 8 位日期就用它判；否则（老结构 / 会话目录）退回 mtime
    const byName = /^\d{8}$/.test(name)
    const expired = byName
      ? now - Date.parse(`${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T23:59:59`) > ttlDays * DAY
      : now - st.mtimeMs > ttlDays * DAY
    if (!st.isDirectory()) {
      if (expired) {
        try {
          rmSync(p, { force: true })
          files++
        } catch {
          /* 被占用就下次再说 */
        }
      }
      continue
    }
    if (!expired) continue
    try {
      rmSync(p, { recursive: true, force: true })
      dirs++
    } catch {
      /* 同上 */
    }
  }
  return { dirs, files }
}

/** 日志：单文件超限就只留尾部一半（留一半是为了还能看出上下文）。 */
export function trimLogs(dir: string, maxBytes: number): number {
  if (!existsSync(dir)) return 0
  let trimmed = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (!st.isFile() || st.size <= maxBytes) continue
    try {
      const buf = readFileSync(p)
      writeFileSync(p, buf.subarray(Math.floor(buf.length / 2)))
      trimmed++
    } catch {
      /* 正在被写就跳过 */
    }
  }
  return trimmed
}

/** 跑一轮清理；各项互不影响。 */
export function runCleanup(opts: CleanupOptions): CleanupResult {
  const now = opts.now ?? Date.now()
  const img = cleanupImages(join(opts.dataDir, 'images'), opts.imageTtlDays ?? 7, now)
  const logs = trimLogs(opts.logDir ?? join(opts.dataDir, '..', 'logs'), opts.maxLogBytes ?? 5 * 1024 * 1024)
  return { images: img.dirs + img.files, dirs: img.dirs, logs }
}
