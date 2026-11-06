/** 事件与能力的公共类型。纯类型，无 IO；内核与插件共用。 */

/** 能力的效果分类：决定是否必须过策略闸、是否只能走发件箱。 */
export type CapabilityEffect = 'none' | 'message' | 'session' | 'doc' | 'task'

/** 事件总线里的一条事件。消息事件的 id 与 events.id 相同；领域事件必须给自然键。 */
export interface BusEvent<T = unknown> {
  /** 全局单调递增，投递游标用 */
  seq: number
  /** 幂等键：消息事件 = events.id；领域事件 = 调用方给的自然键 */
  id: string
  /** 事件种类，如 message.received / session.turn.ended */
  kind: string
  /** 产生事件的插件 id 或 'kernel' */
  source: string
  /** 会话/工作项/文档 id，用于观测与分队列 */
  subject?: string
  at: string
  payload: T
  /** 因果链：上游事件 id 或能力收据 id */
  causedBy?: string
}

export type EventHandler = (e: BusEvent) => Promise<void> | void

/** 消息入站事件（P1 阶段所有 legacy 来源都记成这一种；卡片回调在 P3 归一）。 */
export const MESSAGE_RECEIVED = 'message.received'
/** 中间层分析完成：分发场景只消费这一种，不再各自理解原始消息。 */
export const MESSAGE_ANALYZED = 'message.analyzed'
/** 分发决策完成；出口消费者只读 targets，不重复理解消息。 */
export const DISTRIBUTION_DECIDED = 'distribution.decided'

/** P2.6 开窗事件：requested → opened/failed → ready。 */
export const SESSION_OPEN_REQUESTED = 'session.open.requested'
export const SESSION_OPENED = 'session.opened'
export const SESSION_OPEN_FAILED = 'session.open.failed'
export const SESSION_READY = 'session.ready'
export const SESSION_PROGRESS = 'session.progress'
export const SESSION_TURN_ENDED = 'session.turn.ended'

/** 能力结果事件：副作用能力提交后的终态，payload 带 receiptId 与结果摘要。 */
export const EFFECT_DONE = 'effect.done'
export const EFFECT_FAILED = 'effect.failed'
