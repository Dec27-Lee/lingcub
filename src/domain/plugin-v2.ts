/** 插件清单 v2 与上下文。纯类型，无 IO；实现契约在 docs/002。 */

import type { z } from 'zod'
import type { CapabilityEffect, EventHandler } from './events.ts'
import type { Channel, Classifier, DocPort, Executor, Log, Source } from './ports.ts'
import type { Event } from './types.ts'

export const PLUGIN_ROLES = [
  'source',
  'channel',
  'executor',
  'classifier',
  'doc',
  'scenario',
  'capability',
] as const

export type PluginRole = (typeof PLUGIN_ROLES)[number]

export interface CapabilityDecl {
  name: string
  effect: CapabilityEffect
  input?: z.ZodTypeAny
  output?: z.ZodTypeAny
  timeoutMs?: number
}

export interface ManifestV2 {
  v: 2
  id: string
  /** 仅用于 doctor/配置页分组，不影响注册路径 */
  roles: readonly PluginRole[]
  provides?: readonly CapabilityDecl[]
  /** 必需能力：缺一个就启动失败 */
  needs?: readonly string[]
  /** 可选能力：缺了只降级，调用时抛 CapabilityMissingError */
  wants?: readonly string[]
  /** 订阅的事件 kind；必须与 ctx.on 的 kind 一致 */
  on?: readonly string[]
  /** 该场景独占的控制开关；开关没切到对应档时运行时不装配它，避免双回 */
  owns?: readonly ('status' | 'stop' | 'new' | 'messages')[]
  /**
   * 启用后如何生效。默认 restart：改开关后重启进程。
   * hot 预留给无端口、无事件订阅的纯能力插件；当前运行时尚未实现热启停。
   */
  activation?: 'restart' | 'hot'
  config: z.ZodTypeAny
}

export interface PluginContextV2 {
  readonly id: string
  readonly roles: readonly PluginRole[]
  readonly config: unknown
  readonly log: Log
  /** 能力是否已注册（wants 降级用） */
  has(name: string): boolean
  call<O = unknown>(name: string, input: unknown): Promise<O>
  submit(
    name: string,
    input: unknown,
    opKey: string,
    opts?: { eventId?: string },
  ): Promise<{ receiptId: number; duplicate: boolean; status: 'submitted' | 'would-do' | 'pending' }>
  /** 只能注册清单里声明过的能力；效果由能力名家族决定 */
  provide<I, O>(
    name: string,
    spec: { input: z.ZodType<I>; output?: z.ZodType<O>; timeoutMs?: number },
    impl: (input: I) => Promise<O> | O,
  ): void
  on(kind: string, handler: EventHandler): void
  /**
   * 追加领域事件。id 缺省时按 (插件, kind, dedupeKey|payload) 内容派生：
   * 同一条平台消息重复投递得到同一个 id，内置幂等。
   */
  emit(
    kind: string,
    payload: unknown,
    opts?: { id?: string; dedupeKey?: string; subject?: string; causedBy?: string },
  ): { seq: number; duplicate: boolean }
  /** 入站消息：写 events + event_log（同一事务），供 task.open 的 intent 外键使用。 */
  ingest(event: Event): { seq: number; duplicate: boolean }
  /** 注册端口实现（频道/执行器/源/分类器）；v1 的 ctx.register 在 v2 的等价物。 */
  registerPort(port: Source | Classifier | Executor | Channel | DocPort): void
}

export interface PluginModuleV2 {
  manifest: ManifestV2
  setup(ctx: PluginContextV2): void
  /** 可选：所有插件 setup 完之后按依赖顺序调用一次 */
  start?(ctx: PluginContextV2): Promise<void> | void
  /** 可选：停止时逆序调用；必须幂等且不抛 */
  stop?(ctx: PluginContextV2): Promise<void> | void
}
