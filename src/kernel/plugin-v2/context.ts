/** v2 插件上下文：能力调用/提交、事件订阅/追加。实现细节全部经内核，不直接碰库。 */

import type { z } from 'zod'
import type { Capabilities } from '../capabilities.ts'
import type { EventLog } from '../event-log.ts'
import { eventId } from '../ids.ts'
import { stableJson } from '../stable-json.ts'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Log } from '../../domain/ports.ts'

export interface ContextDeps {
  manifest: ManifestV2
  config: unknown
  log: Log
  eventLog: EventLog
  capabilities: Capabilities
  registerPort?: (port: unknown) => void
}

export function createPluginContext(deps: ContextDeps): PluginContextV2 {
  const { manifest } = deps
  const declared = new Map((manifest.provides ?? []).map((c) => [c.name, c]))
  const provided = new Set<string>()
  const subscribed = new Set<string>()

  return {
    id: manifest.id,
    roles: manifest.roles,
    config: deps.config,
    log: (level, msg, extra) => deps.log(level, `[${manifest.id}] ${msg}`, extra),

    has: (name) => deps.capabilities.has(name),

    call: <O = unknown>(name: string, input: unknown): Promise<O> =>
      deps.capabilities.call<O>(name, input, { caller: manifest.id }),

    submit: (name, input, opKey, opts) =>
      deps.capabilities.submit(name, input, { caller: manifest.id, opKey, eventId: opts?.eventId }),

    provide<I, O>(
      name: string,
      spec: { input: z.ZodType<I>; output?: z.ZodType<O>; timeoutMs?: number },
      impl: (input: I) => Promise<O> | O,
    ): void {
      const decl = declared.get(name)
      if (!decl) throw new Error(`插件 ${manifest.id} 未在 manifest.provides 声明能力：${name}`)
      if (provided.has(name)) throw new Error(`插件 ${manifest.id} 重复注册能力：${name}`)
      provided.add(name)
      deps.capabilities.provide(
        { name, effect: decl.effect, input: spec.input, output: spec.output, timeoutMs: spec.timeoutMs },
        impl,
        { provider: manifest.id },
      )
    },

    on(kind, handler): void {
      if (!(manifest.on ?? []).includes(kind)) {
        throw new Error(`插件 ${manifest.id} 未在 manifest.on 声明事件：${kind}`)
      }
      if (subscribed.has(kind)) throw new Error(`插件 ${manifest.id} 重复订阅事件：${kind}`)
      subscribed.add(kind)
      deps.eventLog.subscribe(manifest.id, kind, handler)
    },

    emit(kind, payload, opts = {}) {
      if (!kind) throw new Error(`插件 ${manifest.id} 发出的事件缺 kind`)
      const id = opts.id ?? eventId(manifest.id, opts.dedupeKey ?? stableJson(payload))
      return deps.eventLog.append({
        id,
        kind,
        source: manifest.id,
        subject: opts.subject,
        payload,
        causedBy: opts.causedBy,
      })
    },

    ingest(event) {
      if (event.source !== manifest.id && !manifest.id.endsWith(event.source)) {
        // 来源名不必等于插件 id（source-dingtalk 与 channel-dingtalk），但必须能对上，避免冒充。
        throw new Error(`插件 ${manifest.id} 不能冒充来源 ${event.source}`)
      }
      return deps.eventLog.appendMessage(event)
    },

    registerPort(port) {
      if (!deps.registerPort) throw new Error(`插件 ${manifest.id} 所在装配未提供端口注册`)
      deps.registerPort(port)
    },
  }
}
