/**
 * 类型化能力注册表：提交 + 收据。
 *
 * 规则（见任务文档 4.3）：
 * - 能力名决定效果：session./notify./transport./doc./task. 由内核定义，插件不能把副作用声明成 none。
 * - effect != none 只能 `submit`：落收据（op_key 唯一）→ 入发件箱 → 返回 receiptId；结果由 effect.done 事件带回。
 * - effect = none 才能同步 `call` 并拿到返回值。
 * - 每次调用/提交都落一行审计；输入输出用 zod 校验。
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CapabilityEffect } from '../domain/events.ts'
import { effectOfName, isKernelCapability, pluginCapabilityProblem } from '../domain/capability-names.ts'
import type { Log } from '../domain/ports.ts'
import { safeJson, stableJson } from './stable-json.ts'
import type { Store } from './store.ts'

export interface CapabilitySpec<I = unknown, O = unknown> {
  name: string
  effect: CapabilityEffect
  input: z.ZodType<I>
  output?: z.ZodType<O>
  timeoutMs?: number
}

export type CapabilityImpl<I = unknown, O = unknown> = (
  input: I,
  ctx: { caller: string; receiptId?: number },
) => Promise<O> | O

export interface EnqueueEffectInput {
  receiptId: number
  name: string
  effect: CapabilityEffect
  /** 能力提供者插件 id；transport.* 用它选频道插件 */
  provider: string
  opKey: string
  payload: unknown
  eventId?: string
}

export type EnqueueEffect = (input: EnqueueEffectInput) => { outboxId?: number } | void

/** 三轴闸的判定结果：直接执行 / 只记 would-do / 等确认。 */
export type GateDecision = 'run' | 'would-do' | 'pending'

export interface GateInput {
  name: string
  effect: CapabilityEffect
  caller: string
  input: unknown
  opKey: string
  receiptId: number
}

export type Gate = (input: GateInput) => GateDecision | Promise<GateDecision>

export interface SubmitResult {
  receiptId: number
  duplicate: boolean
  status: 'submitted' | 'would-do' | 'pending'
}

export class CapabilityMissingError extends Error {
  constructor(names: readonly string[]) {
    super(`缺少能力：${names.join(', ')}`)
    this.name = 'CapabilityMissingError'
  }
}

export class CapabilityNotFoundError extends Error {
  constructor(name: string) {
    super(`能力未注册：${name}`)
    this.name = 'CapabilityNotFoundError'
  }
}

interface Registered {
  spec: CapabilitySpec
  impl: CapabilityImpl
  provider: string
  internal: boolean
}

export interface CapabilitiesOptions {
  log: Log
  enqueue?: EnqueueEffect
  gate?: Gate
  now?: () => number
}

export class Capabilities {
  readonly #store: Store
  readonly #log: Log
  readonly #now: () => number
  readonly #enqueue?: EnqueueEffect
  readonly #gate?: Gate
  readonly #registered = new Map<string, Registered>()
  /** 能力名 → 提供者；注销后保留最后一次归属，便于卸载后追查。 */
  readonly #providers = new Map<string, string>()

  constructor(store: Store, opts: CapabilitiesOptions) {
    this.#store = store
    this.#log = opts.log
    this.#now = opts.now ?? Date.now
    this.#enqueue = opts.enqueue
    this.#gate = opts.gate
  }

  /** 注册能力实现。同名只能有一个提供者；插件不能用内核保留前缀。 */
  provide<I, O>(
    spec: CapabilitySpec<I, O>,
    impl: CapabilityImpl<I, O>,
    opts: { provider: string; internal?: boolean },
  ): void {
    this.#assertName(spec, opts.provider, opts.internal === true)
    if (this.#registered.has(spec.name)) {
      const other = this.#registered.get(spec.name)
      throw new Error(`能力重名：${spec.name}（${other?.provider} 与 ${opts.provider}）`)
    }
    this.#registered.set(spec.name, {
      spec: spec as CapabilitySpec,
      impl: impl as CapabilityImpl,
      provider: opts.provider,
      internal: opts.internal === true,
    })
    this.#providers.set(spec.name, opts.provider)
  }

  has(name: string): boolean {
    return this.#registered.has(name)
  }

  /** 注销能力：返回是否真的删掉。收据与审计不动；同名可以再 provide。 */
  remove(name: string): boolean {
    return this.#registered.delete(name)
  }

  /** 能力提供者插件 id；能力注销后仍返回最后一次注册的 provider。 */
  providerOf(name: string): string | undefined {
    return this.#providers.get(name)
  }

  list(): { name: string; effect: CapabilityEffect; provider: string; internal: boolean }[] {
    return [...this.#registered.entries()]
      .map(([name, r]) => ({ name, effect: r.spec.effect, provider: r.provider, internal: r.internal }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 启动检查：needs 缺失要失败，wants 缺失只降级。 */
  check(decl: { id: string; needs?: readonly string[]; wants?: readonly string[] }): {
    missingNeeds: string[]
    missingWants: string[]
  } {
    const missing = (list: readonly string[] | undefined): string[] =>
      (list ?? []).filter((n) => !this.has(n))
    return { missingNeeds: missing(decl.needs), missingWants: missing(decl.wants) }
  }

  /** 同步能力：只有 effect = none 能走这里。 */
  async call<O = unknown>(
    name: string,
    input: unknown,
    ctx: { caller: string; causedBy?: string },
  ): Promise<O> {
    const r = this.#registered.get(name)
    if (!r) throw new CapabilityNotFoundError(name)
    if (r.spec.effect !== 'none') {
      throw new Error(`副作用能力必须用 submit（提交+收据），不能同步 call：${name}`)
    }
    const parsed = r.spec.input.safeParse(input)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      this.#audit({
        name,
        effect: r.spec.effect,
        caller: ctx.caller,
        status: 'error',
        input,
        error: `输入非法：${detail}`,
        durationMs: 0,
        causedBy: ctx.causedBy,
      })
      throw new Error(`能力输入非法（${name}）：${detail}`)
    }
    const start = this.#now()
    try {
      const result = await this.#run(r, parsed.data, { caller: ctx.caller })
      const output = r.spec.output ? r.spec.output.safeParse(result) : undefined
      if (output && !output.success) {
        throw new Error(
          `能力输出非法（${name}）：${output.error.issues.map((i) => i.message).join('; ')}`,
        )
      }
      this.#audit({
        name,
        effect: r.spec.effect,
        caller: ctx.caller,
        status: 'done',
        input: parsed.data,
        result,
        durationMs: this.#now() - start,
        causedBy: ctx.causedBy,
      })
      return (output ? output.data : result) as O
    } catch (err) {
      this.#audit({
        name,
        effect: r.spec.effect,
        caller: ctx.caller,
        status: 'error',
        input: parsed.data,
        error: err instanceof Error ? err.message : String(err),
        durationMs: this.#now() - start,
        causedBy: ctx.causedBy,
      })
      throw err
    }
  }

  /**
   * 副作用能力：落收据 → 过三轴闸 → 入发件箱 → 返回 receiptId。
   * 同一 opKey 重复提交返回同一收据，不再入队（至少一次投递下的幂等收口）。
   */
  async submit(
    name: string,
    input: unknown,
    ctx: { caller: string; opKey: string; causedBy?: string; eventId?: string },
  ): Promise<SubmitResult> {
    const r = this.#registered.get(name)
    if (!r) throw new CapabilityNotFoundError(name)
    if (r.spec.effect === 'none') throw new Error(`无副作用能力不需要 submit：${name}`)
    if (!ctx.opKey) throw new Error(`副作用能力必须带 opKey：${name}`)
    const parsed = r.spec.input.safeParse(input)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      throw new Error(`能力输入非法（${name}）：${detail}`)
    }
    const existing = this.#store.findCapabilityCallByOpKey(ctx.opKey)
    if (existing) {
      const status =
        existing.status === 'would-do' || existing.status === 'pending'
          ? existing.status
          : 'submitted'
      return { receiptId: existing.id, duplicate: true, status }
    }
    if (!this.#enqueue) throw new Error(`发件箱未装配，拒绝提交副作用能力：${name}`)

    const receiptId = this.#store.insertCapabilityCall({
      at: new Date(this.#now()).toISOString(),
      caller: ctx.caller,
      name,
      effect: r.spec.effect,
      status: 'submitted',
      opKey: ctx.opKey,
      inputDigest: digest(parsed.data),
      inputHead: head(parsed.data),
      durationMs: 0,
      causedBy: ctx.causedBy,
    })

    // 三轴闸：observe → 只记 would-do；suggest → 落确认、等确认；auto → 放行。
    let decision: GateDecision = 'run'
    if (this.#gate) {
      try {
        decision = await this.#gate({
          name,
          effect: r.spec.effect,
          caller: ctx.caller,
          input: parsed.data,
          opKey: ctx.opKey,
          receiptId,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.#store.updateCapabilityCall(receiptId, { status: 'failed', error: `闸门失败：${msg}` })
        throw err
      }
    }
    if (decision !== 'run') {
      const status = decision === 'would-do' ? 'would-do' : 'pending'
      this.#store.updateCapabilityCall(receiptId, { status })
      this.#log(
        'info',
        `能力${decision === 'would-do' ? '只记录（observe）' : '待确认（suggest）'}：${name} receipt=${receiptId}`,
      )
      return { receiptId, duplicate: false, status }
    }

    try {
      const queued = this.#enqueue({
        receiptId,
        name,
        effect: r.spec.effect,
        provider: r.provider,
        opKey: ctx.opKey,
        payload: parsed.data,
        eventId: ctx.eventId,
      })
      if (queued?.outboxId !== undefined) {
        this.#store.updateCapabilityCall(receiptId, { outboxId: queued.outboxId })
      }
      return { receiptId, duplicate: false, status: 'submitted' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.#store.updateCapabilityCall(receiptId, { status: 'failed', error: msg })
      this.#log('error', `能力提交失败：${name} — ${msg}`)
      throw err
    }
  }

  #assertName(spec: CapabilitySpec, provider: string, internal: boolean): void {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(spec.name)) {
      throw new Error(`能力名不合法（要求两段以上小写/数字/短横线）：${spec.name}`)
    }
    if (internal) {
      if (!isKernelCapability(spec.name)) {
        throw new Error(`内核能力必须以保留前缀开头：${spec.name}`)
      }
      const family = effectOfName(spec.name)
      if (family && family !== spec.effect) {
        throw new Error(`能力 ${spec.name} 属于 ${family} 家族，效果必须是 ${family}，不能声明为 ${spec.effect}`)
      }
      if (!family && spec.effect !== 'none') {
        throw new Error(`能力 ${spec.name} 不在效果家族内，只能是 effect=none`)
      }
      return
    }
    const problem = pluginCapabilityProblem(provider, spec.name, spec.effect)
    if (problem) throw new Error(problem)
  }

  #run(r: Registered, input: unknown, ctx: { caller: string }): Promise<unknown> {
    const ms = r.spec.timeoutMs ?? 30_000
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`能力超时（${ms}ms）：${r.spec.name}`)), ms)
      timer.unref?.()
    })
    return Promise.race([Promise.resolve().then(() => r.impl(input, ctx)), timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  #audit(row: {
    name: string
    effect: CapabilityEffect
    caller: string
    status: 'done' | 'error'
    input: unknown
    result?: unknown
    error?: string
    durationMs: number
    causedBy?: string
  }): void {
    try {
      this.#store.insertCapabilityCall({
        at: new Date(this.#now()).toISOString(),
        caller: row.caller,
        name: row.name,
        effect: row.effect,
        status: row.status,
        inputDigest: digest(row.input),
        inputHead: head(row.input),
        resultHead: row.result === undefined ? undefined : head(row.result),
        error: row.error,
        durationMs: Math.max(0, row.durationMs),
        causedBy: row.causedBy,
      })
    } catch (err) {
      // 审计写失败不应把业务调用打挂
      this.#log('warn', `能力审计写入失败：${row.name} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function digest(v: unknown): string {
  return createHash('sha256').update(stableJson(v)).digest('hex').slice(0, 32)
}

function head(v: unknown): string {
  const s = safeJson(v)
  return s.length > 2048 ? `${s.slice(0, 2048)}…` : s
}
