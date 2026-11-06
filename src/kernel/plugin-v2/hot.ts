/**
 * 纯能力插件的热加载/卸载。
 *
 * 只处理 activation=hot 且 roles 仅 capability、无事件订阅的 v2 插件：
 * 加载 = 用现有上下文注册能力；卸载 = 逐个 remove 能力。
 * source/channel/executor/scenario/doc 没有可靠卸载生命周期，仍走重启。
 */

import type { Capabilities } from '../capabilities.ts'
import type { Config } from '../config.ts'
import { resolvePluginSections } from '../config-alias.ts'
import type { Log } from '../../domain/ports.ts'
import type { DiscoveredV2 } from './index.ts'
import { discoverPluginsV2 } from './index.ts'
import { createPluginContext } from './context.ts'
import { parsePluginConfig } from './validate.ts'
import type { EventLog } from '../event-log.ts'

export interface HotSyncResult {
  loaded: string[]
  unloaded: string[]
  errors: string[]
}

export class HotCapabilityManager {
  readonly #capabilities: Capabilities
  readonly #eventLog: EventLog
  readonly #log: Log
  readonly #loaded = new Map<string, Set<string>>()

  constructor(deps: { capabilities: Capabilities; eventLog: EventLog; log: Log }) {
    this.#capabilities = deps.capabilities
    this.#eventLog = deps.eventLog
    this.#log = deps.log
  }

  loaded(): string[] {
    return [...this.#loaded.keys()].sort()
  }

  /** 扫描目录并同步；失败只记 errors，不影响已加载的其它插件。 */
  async syncDir(dir: string, config: Config): Promise<HotSyncResult> {
    let entries: DiscoveredV2[]
    try {
      entries = await discoverPluginsV2(dir)
    } catch (err) {
      return { loaded: [], unloaded: [], errors: [err instanceof Error ? err.message : String(err)] }
    }
    return this.sync(entries, config)
  }

  /** 对已发现的 v2 插件同步，避免调用方重复扫描/重复 import。 */
  async sync(entries: readonly DiscoveredV2[], config: Config): Promise<HotSyncResult> {
    const sections = resolvePluginSections(config)
    const result: HotSyncResult = { loaded: [], unloaded: [], errors: [] }
    const wanted = new Set<string>()

    for (const entry of entries) {
      const m = entry.manifest
      if (m.activation !== 'hot') continue
      if (sections.enabled[m.id] !== true) continue
      wanted.add(m.id)
      if (this.#loaded.has(m.id)) continue
      try {
        this.load(entry, sections.sections[m.id] ?? {})
        result.loaded.push(m.id)
        this.#log('info', `热加载能力插件：${m.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`${m.id}: ${msg}`)
        this.#log('warn', `热加载失败 ${m.id}：${msg}`)
      }
    }

    for (const id of [...this.#loaded.keys()]) {
      if (wanted.has(id)) continue
      this.unload(id)
      result.unloaded.push(id)
      this.#log('info', `热卸载能力插件：${id}`)
    }
    return result
  }

  /** 加载一个已校验的 hot 插件；失败时回收本次已注册的能力。 */
  load(entry: DiscoveredV2, rawConfig: unknown): void {
    const m = entry.manifest
    if (m.activation !== 'hot') throw new Error(`插件 ${m.id} 未声明 activation=hot`)
    if (m.roles.length !== 1 || m.roles[0] !== 'capability') {
      throw new Error(`插件 ${m.id} 不是纯 capability，不能热加载`)
    }
    if ((m.on ?? []).length) throw new Error(`插件 ${m.id} 有事件订阅，不能热加载`)

    const config = parsePluginConfig(m, rawConfig)
    const ctx = createPluginContext({
      manifest: m,
      config,
      log: this.#log,
      eventLog: this.#eventLog,
      capabilities: this.#capabilities,
    })
    const names = new Set((m.provides ?? []).map((p) => p.name))
    try {
      entry.module.setup(ctx)
    } catch (err) {
      for (const name of names) {
        if (this.#capabilities.providerOf(name) === m.id) this.#capabilities.remove(name)
      }
      throw err
    }
    this.#loaded.set(m.id, names)
  }

  unload(id: string): boolean {
    const names = this.#loaded.get(id)
    if (!names) return false
    for (const name of names) {
      if (this.#capabilities.providerOf(name) === id) this.#capabilities.remove(name)
    }
    this.#loaded.delete(id)
    return true
  }

  unloadAll(): void {
    for (const id of [...this.#loaded.keys()]) this.unload(id)
  }
}
