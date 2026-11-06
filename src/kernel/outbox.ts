/** 发件箱：所有对外副作用先落库，再由投递器执行。成功才标记 done。 */

import type { Log } from '../domain/ports.ts'
import type { Action } from '../domain/types.ts'
import type { Store, OutboxRow } from './store.ts'

/** 投递器：把一条 Action 真正送出去。必须按 dedupeKey 幂等；可返回平台侧 id 供收据回填。 */
export type Deliver = (action: Action, dedupeKey: string) => Promise<{ externalId?: string } | void>

/** 一条发件箱行的终态；收据据此回填并追加 effect.done / effect.failed。 */
export type SettleOutcome =
  | { status: 'done'; result?: { externalId?: string } }
  | { status: 'dead'; error: string }

export interface OutboxOptions {
  /** 连续失败上限，达到即转 dead 并告警；默认 3 */
  maxAttempts?: number
  log?: Log
  /** 终态回调：用于能力收据回填；抛错只记日志，不影响发件箱状态 */
  onSettled?: (row: OutboxRow, outcome: SettleOutcome) => void
}

export interface TickResult {
  done: number
  failed: number
  dead: number
}

export class Outbox {
  readonly #store: Store
  readonly #deliver: Deliver
  readonly #maxAttempts: number
  readonly #log: Log
  readonly #onSettled?: (row: OutboxRow, outcome: SettleOutcome) => void

  constructor(store: Store, deliver: Deliver, opts: OutboxOptions = {}) {
    this.#store = store
    this.#deliver = deliver
    this.#maxAttempts = opts.maxAttempts ?? 3
    this.#log = opts.log ?? (() => {})
    this.#onSettled = opts.onSettled
  }

  /** 同一 dedupeKey 重复入队只留一行，返回 'duplicate'。 */
  enqueue(
    a: Action,
    dedupeKey: string,
    opts: { notBefore?: number; eventId?: string } = {},
  ): 'enqueued' | 'duplicate' {
    const r = this.#store.enqueue(a, dedupeKey, opts)
    if (r === 'duplicate') this.#log('debug', `发件箱去重，跳过：${dedupeKey}`)
    return r
  }

  /** 取 pending 逐条投递。单条失败不影响后续；超过上限转 dead。 */
  async tick(limit = 10): Promise<TickResult> {
    const rows = this.#store.pendingOutbox(limit)
    const result: TickResult = { done: 0, failed: 0, dead: 0 }
    for (const row of rows) {
      const attempts = row.attempts + 1
      this.#store.markOutbox(row.id, 'dispatched', attempts)
      try {
        const delivered = await this.#deliver(row.action, row.dedupeKey)
        this.#store.markOutbox(row.id, 'done', attempts)
        this.#settle(row, { status: 'done', result: delivered ?? undefined })
        result.done++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (attempts >= this.#maxAttempts) {
          this.#store.markOutbox(row.id, 'dead', attempts, msg)
          this.#settle(row, { status: 'dead', error: msg })
          this.#log('error', `发件箱死信（${attempts} 次失败）：${row.action.kind} ${row.dedupeKey} — ${msg}`)
          result.dead++
        } else {
          this.#store.markOutbox(row.id, 'pending', attempts, msg)
          this.#log('warn', `发件箱重试 ${attempts}/${this.#maxAttempts}：${row.action.kind} — ${msg}`)
          result.failed++
        }
      }
    }
    return result
  }

  #settle(row: OutboxRow, outcome: SettleOutcome): void {
    if (!this.#onSettled) return
    try {
      this.#onSettled(row, outcome)
    } catch (err) {
      this.#log('warn', `发件箱终态回调失败：${row.dedupeKey} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
