/**
 * 持久事件日志 + 投递器。
 *
 * 设计要点（见任务文档 4.4）：
 * - 唯一事件史是 store.event_log；消息事件由 store.insertEvent 与 events 同事务写入。
 * - 新订阅默认从「当前最大 seq」开始，绝不回放历史；回放要显式 since:'beginning'。
 * - 全局串行投递，保持今天「同一时刻只处理一条事件」的单写者语义。
 * - 至少一次：投递前记 dispatched，成功才推进游标；失败退避重试，到顶进死信并越过游标。
 * - handler 有超时，长等待不许放进订阅（否则会冻结唯一 tick）。
 */

import { EFFECT_DONE, EFFECT_FAILED, type BusEvent, type EventHandler } from '../domain/events.ts'
import type { Event } from '../domain/types.ts'
import type { Log } from '../domain/ports.ts'
import type { Store } from './store.ts'

export interface EventLogOptions {
  log: Log
  /** 每轮最多投递几条（所有订阅合计） */
  maxPerTick?: number
  /** 连续失败上限，达到即死信并越过游标 */
  maxAttempts?: number
  backoffBaseMs?: number
  backoffCapMs?: number
  /** 滞后超过这个数就冻结该订阅 */
  maxLag?: number
  /** 恢复时最多补投多少条；超出直接跳到当前（防一次性补投历史） */
  maxCatchUp?: number
  /** 单条 handler 超时 */
  handlerTimeoutMs?: number
  now?: () => number
}

export interface TickResult {
  delivered: number
  retried: number
  dead: number
  skipped: number
}

type Since = 'now' | 'beginning'

export class EventLog {
  readonly #store: Store
  readonly #log: Log
  readonly #maxPerTick: number
  readonly #maxAttempts: number
  readonly #backoffBaseMs: number
  readonly #backoffCapMs: number
  readonly #maxLag: number
  readonly #maxCatchUp: number
  readonly #handlerTimeoutMs: number
  readonly #now: () => number
  readonly #handlers = new Map<string, Map<string, EventHandler>>()

  constructor(store: Store, opts: EventLogOptions) {
    this.#store = store
    this.#log = opts.log
    this.#maxPerTick = opts.maxPerTick ?? 50
    this.#maxAttempts = opts.maxAttempts ?? 5
    this.#backoffBaseMs = opts.backoffBaseMs ?? 1_000
    this.#backoffCapMs = opts.backoffCapMs ?? 60_000
    this.#maxLag = opts.maxLag ?? 5_000
    this.#maxCatchUp = opts.maxCatchUp ?? 200
    this.#handlerTimeoutMs = opts.handlerTimeoutMs ?? 5_000
    this.#now = opts.now ?? Date.now
  }

  /** 声明订阅。同一 (subscriber, kind) 只能有一个 handler；重复声明直接失败。 */
  subscribe(
    subscriber: string,
    kind: string,
    handler: EventHandler,
    opts: { since?: Since } = {},
  ): void {
    if (!subscriber || !kind) throw new Error('订阅必须给 subscriber 与 kind')
    let byKind = this.#handlers.get(subscriber)
    if (!byKind) {
      byKind = new Map()
      this.#handlers.set(subscriber, byKind)
    }
    if (byKind.has(kind)) throw new Error(`重复订阅：${subscriber}/${kind}`)
    byKind.set(kind, handler)
    // 新订阅从当前最大 seq 起（不回放）；已有订阅行则保留旧游标（重启续投）。
    const since = opts.since === 'beginning' ? 0 : this.#store.eventLogMaxSeq()
    this.#store.ensureSubscription(subscriber, kind, since)
  }

  /** 入站消息：写 events（消息明细）+ event_log（唯一史），同一事务、同一 id。 */
  appendMessage(event: Event): { seq: number; duplicate: boolean } {
    const inserted = this.#store.insertEvent(event)
    const row = this.#store.getEventLog(event.id)
    if (!row) throw new Error(`事件落库后找不到事件史行：${event.id}`)
    return { seq: row.seq, duplicate: !inserted }
  }

  /**
   * 卸载订阅：删掉内存 handler 与持久订阅行（游标随之消失），返回删除的订阅条数。
   * 事件史不动；重复调用返回 0。之后再 subscribe 同 (subscriber, kind) 从当前最大 seq 起。
   */
  unsubscribe(subscriber: string): number {
    this.#handlers.delete(subscriber)
    return this.#store.deleteSubscriptions(subscriber)
  }

  /** 领域事件追加。id 必须是自然键；消息事件走 store.insertEvent，不经过这里。 */
  append(e: {
    id: string
    kind: string
    source: string
    subject?: string
    at?: string
    payload: unknown
    causedBy?: string
  }): { seq: number; duplicate: boolean } {
    if (!e.id) throw new Error('领域事件必须给自然键 id')
    if (!e.kind) throw new Error('领域事件必须给 kind')
    return this.#store.appendEventLog({
      id: e.id,
      kind: e.kind,
      source: e.source,
      subject: e.subject,
      at: e.at ?? new Date(this.#now()).toISOString(),
      payload: e.payload,
      causedBy: e.causedBy,
    })
  }

  /** 一轮投递：全局串行，按 (subscriber, kind) 各自保序。 */
  async tick(limit = this.#maxPerTick): Promise<TickResult> {
    const result: TickResult = { delivered: 0, retried: 0, dead: 0, skipped: 0 }
    const upTo = this.#store.eventLogMaxSeq()

    const subscribers = [...this.#handlers.keys()].sort()
    for (const subscriber of subscribers) {
      const byKind = this.#handlers.get(subscriber)
      if (!byKind) continue
      for (const kind of [...byKind.keys()].sort()) {
        if (result.delivered + result.dead >= limit) return result
        const handler = byKind.get(kind)
        const sub = this.#store.getSubscription(subscriber, kind)
        if (!handler || !sub || !sub.enabled) continue

        let cursor = sub.cursor
        if (upTo - cursor > this.#maxLag) {
          this.#store.setSubscriptionEnabled(subscriber, kind, false)
          this.#log('error', `订阅滞后 ${upTo - cursor} 条，已冻结：${subscriber}/${kind}`)
          continue
        }
        if (upTo - cursor > this.#maxCatchUp) {
          const skipped = upTo - cursor
          this.#store.advanceSubscription(subscriber, kind, upTo)
          this.#store.deadDelivery(subscriber, kind, upTo, 0, `积压 ${skipped} 条，跳过不补投`)
          this.#log('warn', `订阅积压 ${skipped} 条，跳到 ${upTo}：${subscriber}/${kind}`)
          result.skipped += skipped
          cursor = upTo
        }

        while (result.delivered + result.dead < limit) {
          const nowMs = this.#now()
          const pending = this.#store.pendingDelivery(subscriber, kind)
          let event: BusEvent | null
          let attempts: number
          if (pending) {
            // 队头未到点：这条流暂停（保序的代价）
            if (pending.nextAt > nowMs) break
            event = this.#store.getEventLogAt(kind, pending.seq)
            attempts = pending.attempts + 1
          } else {
            const next = this.#store.eventLogAfter(kind, cursor, 1)[0]
            if (!next || next.seq > upTo) break
            event = next
            attempts = 1
          }
          if (!event) break

          this.#store.markDeliveryDispatched(subscriber, kind, event.seq, attempts)
          try {
            await this.#runHandler(handler, event)
            this.#store.completeDelivery(subscriber, kind, event.seq)
            cursor = Math.max(cursor, event.seq)
            result.delivered++
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (attempts >= this.#maxAttempts) {
              this.#store.deadDelivery(subscriber, kind, event.seq, attempts, msg)
              this.#log('error', `事件死信（${attempts} 次失败）：${subscriber}/${kind} seq=${event.seq} — ${msg}`)
              cursor = Math.max(cursor, event.seq)
              result.dead++
            } else {
              const nextAt = nowMs + Math.min(this.#backoffBaseMs * 2 ** (attempts - 1), this.#backoffCapMs)
              this.#store.retryDelivery(subscriber, kind, event.seq, attempts, nextAt, msg)
              this.#log('warn', `事件重试 ${attempts}/${this.#maxAttempts}：${subscriber}/${kind} seq=${event.seq} — ${msg}`)
              result.retried++
              break // 保序：队头没成功就不投后面的
            }
          }
        }
      }
    }
    return result
  }

  /** 崩溃恢复：dispatched 未完成的回到 pending。只在常驻进程启动时调用。 */
  recover(): number {
    return this.#store.recoverDeliveries()
  }

  /** 每个订阅的滞后情况（doctor/面板用）。 */
  lag(): { subscriber: string; kind: string; cursor: number; lag: number }[] {
    const upTo = this.#store.eventLogMaxSeq()
    return this.#store.listSubscriptions().map((s) => ({
      subscriber: s.subscriber,
      kind: s.kind,
      cursor: s.cursor,
      lag: Math.max(0, upTo - s.cursor),
    }))
  }

  /** 清理：事件史按 TTL + 最小游标；死信按 TTL。 */
  prune(ttlMs: number): { events: number; deliveries: number } {
    const cutoff = new Date(this.#now() - ttlMs).toISOString()
    return this.#store.pruneEventLog(cutoff, cutoff)
  }

  #runHandler(handler: EventHandler, event: BusEvent): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`事件处理超时（${this.#handlerTimeoutMs}ms）：${event.kind}`)),
        this.#handlerTimeoutMs,
      )
      timer.unref?.()
    })
    return Promise.race([Promise.resolve().then(() => handler(event)), timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
}

/** 收据结果事件的固定 kind，便于场景按 receiptId 过滤。 */
export const EFFECT_EVENT_KINDS = { done: EFFECT_DONE, failed: EFFECT_FAILED } as const
