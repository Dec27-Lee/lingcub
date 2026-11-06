/** 来源启动：旧配置段与 v2 插件注册的端口都算来源，同一插件只启一次。 */

import type { Event } from '../domain/types.ts'
import type { Log, Source } from '../domain/ports.ts'
import type { Ports } from './wiring.ts'

export interface StartSourcesInput {
  ports: Ports
  sources: Record<string, { enabled: boolean; plugin: string }>
  /** 本次装配启用的 v2 插件 id；只有它们注册的端口才额外启动 */
  v2Plugins: readonly string[]
  emit: (e: Event) => void
  log: Log
}

export interface StartedSources {
  started: string[]
  stop: () => Promise<void>
}

export async function startSources(input: StartSourcesInput): Promise<StartedSources> {
  const { ports, sources, emit, log, v2Plugins } = input
  const used = new Set<string>()
  const handles: { name: string; source: Source }[] = []

  const startOne = async (name: string, plugin: string, source: Source): Promise<void> => {
    await source.start(emit)
    used.add(plugin)
    handles.push({ name, source })
    log('info', `来源已启动：${name}`)
  }

  for (const [name, cfg] of Object.entries(sources)) {
    if (!cfg.enabled) continue
    const source = ports.sources.get(cfg.plugin)
    if (!source) {
      log('error', `来源 ${name} 引用的插件 ${cfg.plugin} 未装配，跳过`)
      continue
    }
    await startOne(name, cfg.plugin, source)
  }

  // v2 插件通过 registerPort 注册、不在旧 sources 段：同样要启动，否则永远没有回调。
  for (const [id, source] of ports.sources) {
    if (!v2Plugins.includes(id)) continue
    if (used.has(id)) continue
    await startOne(`plugin:${id}`, id, source)
  }

  return {
    started: handles.map((h) => h.name),
    stop: async () => {
      for (const h of [...handles].reverse()) {
        try {
          await h.source.stop()
        } catch (err) {
          log('warn', `来源停止失败：${h.name} — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },
  }
}
