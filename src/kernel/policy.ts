/**
 * 三轴闸：mode × effect × 风险。
 *
 * - effect = none：直接放行（纯计算/查询不产生副作用）。
 * - observe：只记 would-do，不入发件箱。
 * - suggest：落 confirmation 行，等确认后再执行同一收据。
 * - auto：放行；会话类能力的工作区门禁仍由 session.start 自己校验 allowRoots。
 *
 * 风险轴（allowRoots/置信度）不在这里重复实现：它属于 session.* 的实现细节，
 * 闸只回答「这个档位是否允许产生副作用」。
 */

import type { CapabilityEffect } from '../domain/events.ts'
import type { Log } from '../domain/ports.ts'
import type { Config } from './config.ts'
import type { Gate, GateDecision, GateInput } from './capabilities.ts'
import type { Store } from './store.ts'

export interface PolicyOptions {
  config: Config
  store: Store
  log: Log
  now?: () => number
  /** suggest 档落确认后回调；runtime 用它发 confirmation.requested 事件 */
  onPending?: (req: GateInput, confirmationId: number) => void
}

export function createGate(opts: PolicyOptions): Gate {
  const now = opts.now ?? Date.now
  return (req): GateDecision => {
    if (req.effect === 'none') return 'run'
    if (opts.config.mode === 'observe') return 'would-do'
    // 通知类是对外说话，不是业务副作用：建议/确认本身靠它送达，不能再被同一道闸拦住。
    if (req.effect === 'message' && (req.name.startsWith('notify.') || req.name.startsWith('transport.'))) {
      return 'run'
    }
    if (opts.config.mode === 'suggest') {
      const id = opts.store.insertConfirmation({
        receiptId: req.receiptId,
        caller: req.caller,
        name: req.name,
        payload: req.input,
        createdAt: new Date(now()).toISOString(),
      })
      opts.onPending?.(req, id)
      return 'pending'
    }
    return 'run'
  }
}
