/** 发件箱终态 → 能力收据回填 + effect.done/effect.failed 事件。 */

import { EFFECT_DONE, EFFECT_FAILED } from '../domain/events.ts'
import type { Log } from '../domain/ports.ts'
import type { OutboxRow, Store } from './store.ts'
import type { SettleOutcome } from './outbox.ts'
import type { EventLog } from './event-log.ts'

export function createReceiptSettler(
  store: Store,
  eventLog: EventLog,
  log: Log,
): (row: OutboxRow, outcome: SettleOutcome) => void {
  return (row, outcome) => {
    const call = store.findCapabilityCallByOutboxId(row.id)
    if (!call) return
    const started = Date.parse(call.at)
    const durationMs = Number.isNaN(started) ? 0 : Math.max(0, Date.now() - started)
    if (outcome.status === 'done') {
      store.updateCapabilityCall(call.id, {
        status: 'done',
        resultHead: outcome.result?.externalId ? JSON.stringify(outcome.result) : undefined,
        durationMs,
      })
    } else {
      store.updateCapabilityCall(call.id, { status: 'failed', error: outcome.error, durationMs })
    }
    const r = eventLog.append({
      id: `effect:${call.id}:${outcome.status}`,
      kind: outcome.status === 'done' ? EFFECT_DONE : EFFECT_FAILED,
      source: 'kernel',
      subject: `receipt:${call.id}`,
      payload: {
        receiptId: call.id,
        name: call.name,
        effect: call.effect,
        externalId: outcome.status === 'done' ? outcome.result?.externalId : undefined,
        error: outcome.status === 'dead' ? outcome.error : undefined,
      },
      causedBy: call.opKey ?? undefined,
    })
    log(
      'info',
      `收据 ${call.id} ${outcome.status === 'done' ? '完成' : '失败'}：${call.name}${r.duplicate ? '（事件重复）' : ''}`,
    )
  }
}
