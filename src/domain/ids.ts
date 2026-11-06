import { createHash } from 'node:crypto'

/** 内容派生 id：同一 (source, externalId) 永远得到同一个值，用于幂等落库。 */
function pair(a: string, b: string): string {
  return `${a.length}:${a}${b.length}:${b}`
}

export function eventId(source: string, externalId: string): string {
  return createHash('sha256').update(pair(source, externalId)).digest('hex').slice(0, 16)
}

/** Work id 由 Intent + 序号派生，重放时稳定。 */
export function workId(intentEventId: string, seq = 0): string {
  return createHash('sha256').update(`work\u0000${intentEventId}\u0000${seq}`).digest('hex').slice(0, 16)
}

/** 投递去重键：同一条出站消息重复投递只发一次。 */
export function dedupeKey(workIdValue: string, step: string): string {
  return createHash('sha256').update(`out\u0000${workIdValue}\u0000${step}`).digest('hex').slice(0, 16)
}
