/**
 * 读 dsh 会话转录，取「最近一轮的助手正文」。
 *
 * dsh 把会话写成**多帧拼接**的 zstd（`~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd`，实测 31 MB）：
 * Node 的 `zstdDecompressSync` 只解第一帧，流式解到第二帧就报 `Unknown frame descriptor`。
 * 所以必须自己按帧魔数切开、逐帧解（实测尾部 4 MB = 3419 帧 / 6070 条记录，毫秒级）。
 *
 * 一轮的边界是 `turn/end`，正文在同 turn 的 `assistant/message` 里：
 * `data.message.content[]` 中 `type === 'text'` 的块才是给人看的话，
 * `reasoning` 是思考过程、`tool-call` 是工具调用，都不能发出去。
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 一帧一行 JSONL；只保留解析成功且有 `type` 的记录。 */
export interface DshRecord {
  type: string
  seq?: number
  time?: number
  data?: {
    turn?: number
    step?: number
    message?: { role?: string; content?: unknown }
    [k: string]: unknown
  }
}

/** 按 zstd 帧魔数切开；尾部读多了会切出半截首帧，解不开的自然被跳过。 */
export function splitZstdFrames(buf: Buffer): Buffer[] {
  const starts: number[] = []
  let i = buf.indexOf(MAGIC)
  while (i >= 0) {
    starts.push(i)
    i = buf.indexOf(MAGIC, i + 4)
  }
  const frames: Buffer[] = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    frames.push(buf.subarray(starts[k], end))
  }
  return frames
}

/** 清掉正文里的 XML 包装（dsh 会把工具结果以标签形式塞进 content 块）。 */
function plainText(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从一条 `message.content` 里取「人看的正文」（丢掉 reasoning / tool-call / tool-result）。 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return plainText(content)
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type?: string; text?: string } => {
      const o = b as { type?: string; text?: unknown }
      return o?.type === 'text' && typeof o.text === 'string'
    })
    .map((b) => plainText(b.text))
    .filter(Boolean)
    .join('\n')
}

export interface DshTurn {
  /** 这一轮的标识：`turn/end` 的 seq，单调唯一，可直接用来判重 */
  id: string
  /** 助手的最终回答 */
  text: string
  /** 这一轮开场你说的话（拿不到就没有） */
  said?: string
  /** 结束时间（毫秒时间戳） */
  endedAt?: number
}

/**
 * 从记录流里取**最后一个已结束的轮次**。
 *
 * 只认 `turn/end`：最后一轮还在跑时（没有 end）不能当结果发出去，等下一拍。
 */
export function lastFinishedTurn(records: readonly DshRecord[]): DshTurn | null {
  let endIdx = -1
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.type === 'turn/end') {
      endIdx = i
      break
    }
  }
  if (endIdx < 0) return null
  const end = records[endIdx]!
  const turnNo = end.data?.turn
  if (typeof turnNo !== 'number') return null

  let text = ''
  let said: string | undefined
  for (let i = 0; i <= endIdx; i++) {
    const r = records[i]
    if (!r || r.data?.turn !== turnNo) continue
    if (r.type === 'user/message') {
      const t = contentText(r.data?.message?.content)
      if (t) said = t // 一个 turn 里可能有多条 user/message（工具结果回填），取最后一条有文字的
    } else if (r.type === 'assistant/message') {
      const t = contentText(r.data?.message?.content)
      if (t) text = t // 同理：一个 turn 有多个 step，最终答复是最后一条带正文的
    }
  }
  if (!text) return null
  return { id: String(end.seq ?? endIdx), text, said, endedAt: end.time }
}

/**
 * 读文件尾部若干字节并解析成记录；尾部找不到 `turn/end` 就把窗口翻倍再读。
 * 返回 undefined 表示文件读不到。
 */
export function readDshRecords(file: string, maxBytes = 2 * 1024 * 1024, capBytes = 32 * 1024 * 1024): DshRecord[] | undefined {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return undefined
  }
  let window = Math.min(maxBytes, size)
  for (;;) {
    let records: DshRecord[]
    try {
      // 只读尾部：这个文件实测 31 MB，整份读进来再切帧是浪费
      const fd = openSync(file, 'r')
      let buf: Buffer
      try {
        buf = Buffer.alloc(window)
        readSync(fd, buf, 0, window, Math.max(0, size - window))
      } finally {
        closeSync(fd)
      }
      records = []
      for (const frame of splitZstdFrames(buf)) {
        let out: string
        try {
          out = zstdDecompressSync(frame).toString('utf8')
        } catch {
          continue // 半截帧 / 坏帧
        }
        for (const line of out.split('\n')) {
          if (!line.trim()) continue
          try {
            const d = JSON.parse(line) as DshRecord
            if (d && typeof d.type === 'string') records.push(d)
          } catch {
            /* 坏行跳过 */
          }
        }
      }
    } catch {
      return undefined
    }
    if (records.some((r) => r.type === 'turn/end') || window >= capBytes || window >= size) return records
    window = Math.min(window * 2, capBytes, size)
  }
}

/** mtime 缓存：状态卡 15 秒一拍、扫窗口 20 秒一拍，文件没变就不必重解。 */
const turnCache = new Map<string, { mtimeMs: number; turn: DshTurn | null }>()

/** 按会话 id 找 `~/.dsh/sessions/<slug>/<id>/session.v*.jsonl.zstd`（多个版本取最新）。 */
export function findDshTranscript(sessionId: string, sessionsDir = join(homedir(), '.dsh', 'sessions')): string | undefined {
  if (!sessionId) return undefined
  let slugs: string[]
  try {
    slugs = readdirSync(sessionsDir)
  } catch {
    return undefined
  }
  for (const slug of slugs) {
    const dir = join(sessionsDir, slug, sessionId)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    const cands = files
      .filter((f) => f.startsWith('session.v') && f.endsWith('.jsonl.zstd'))
      .map((f) => join(dir, f))
    if (!cands.length) continue
    cands.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    return cands[0]
  }
  return undefined
}

/** 这个 dsh 会话最近一轮跑完的正文；读不到 / 还没跑完 → null。 */
export function lastDshTurn(file: string): DshTurn | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return null
  }
  const hit = turnCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.turn
  const records = readDshRecords(file)
  const turn = records ? lastFinishedTurn(records) : null
  turnCache.set(file, { mtimeMs, turn })
  return turn
}
