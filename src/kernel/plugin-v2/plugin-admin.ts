/**
 * 插件运维：安装重扫 + 启停开关。
 *
 * 两者都只在内存里算，落盘只有一件事：把开关写进 `data/local.json` 覆盖层，
 * `config/*.yaml` 是带注释的基线，程序从不写回。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfigLayered, writeOverlay, type Config } from '../config.ts'
import { discoverPlugins } from '../registry.ts'
import { discoverPluginsV2 } from './index.ts'
import { installedPlugins, type InstalledPlugin } from './catalog.ts'
import { PLUGIN_DIR } from '../wiring.ts'

export type { InstalledPlugin }

/** 每次调用都重新扫描：新装/卸载的插件下一次就能看见，不缓存。 */
export async function rescanInstalled(dir: string, config: Config): Promise<InstalledPlugin[]> {
  if (!existsSync(dir)) return []
  const [v1, v2] = await Promise.all([discoverPlugins(dir), discoverPluginsV2(dir)])
  return installedPlugins(v1, v2, config)
}

export interface SetPluginEnabledOptions {
  /** 仓库根：读 `<root>/config/lingcub.yaml`，写 `<root>/data/local.json` */
  root: string
  id: string
  enabled: boolean
  /** 插件目录；缺省跟随内核文件位置（开发 `src/plugins`，构建后 `dist/plugins`） */
  pluginDir?: string
}

export interface PluginToggleResult {
  /** 开关是否真的落盘；false 时 message 说明原因，调用方直接展示 */
  applied: boolean
  restartRequired: boolean
  message: string
}

/** v1 的 kind → 该插件在 config 里挂的旧四段 */
const V1_SECTION = {
  source: 'sources',
  channel: 'channels',
  classifier: 'classifiers',
  executor: 'executor_policies',
} as const

type Plan = { ok: true; patch: Record<string, unknown>; where: string } | { ok: false; message: string }

/** 同一插件只能挂一份配置：已有段就改那一段，没有才用插件 id 当键。 */
function planV2(config: Config, plugin: InstalledPlugin, enabled: boolean): Plan {
  const natural = plugin.roles.includes('scenario')
    ? (['scenarios', 'plugins'] as const)
    : (['plugins', 'scenarios'] as const)
  for (const table of natural) {
    const hit = Object.entries(config[table]).find(([name, s]) => (s.plugin ?? name) === plugin.id)
    if (hit) {
      return { ok: true, patch: { [table]: { [hit[0]]: { plugin: plugin.id, enabled } } }, where: `${table}.${hit[0]}` }
    }
  }
  const table = natural[0]
  return { ok: true, patch: { [table]: { [plugin.id]: { plugin: plugin.id, enabled } } }, where: `${table}.${plugin.id}` }
}

function planV1(config: Config, plugin: InstalledPlugin, enabled: boolean): Plan {
  const kind = plugin.roles[0] ?? ''
  const table = V1_SECTION[kind as keyof typeof V1_SECTION]
  if (!table) {
    return { ok: false, message: `插件 ${plugin.id} 的角色（${plugin.roles.join('/') || '空'}）没有对应配置段` }
  }
  const sections = config[table] as Record<string, { plugin: string }>
  const hit = Object.entries(sections).find(([, entry]) => entry.plugin === plugin.id)
  if (hit) {
    return { ok: true, patch: { [table]: { [hit[0]]: { plugin: plugin.id, enabled } } }, where: `${table}.${hit[0]}` }
  }
  // executor 策略光有 plugin 不够：allowRoots 等门禁字段得人来填，程序不替人编。
  if (table === 'executor_policies') {
    return {
      ok: false,
      message: `executor 插件 ${plugin.id} 还没有 executor_policies 配置：先在 config/lingcub.yaml 补齐 allowRoots 等必填项，再改开关`,
    }
  }
  return { ok: true, patch: { [table]: { [plugin.id]: { plugin: plugin.id, enabled } } }, where: `${table}.${plugin.id}` }
}

/** 只有「纯 capability + activation=hot」的 v2 插件按声明不要求重启；其余一律要求。 */
function needsRestart(plugin: InstalledPlugin): boolean {
  const pureCapability = plugin.roles.length === 1 && plugin.roles[0] === 'capability'
  return !(plugin.api === 'v2' && plugin.activation === 'hot' && pureCapability)
}

/**
 * 改一个插件的启停开关：重扫安装台账 → 找到它 → 算覆盖层补丁 → `writeOverlay` 校验后落盘。
 * 校验失败只返回 applied=false，不抛异常，便于 API 直接把 message 回给页面。
 */
export async function setPluginEnabled(opts: SetPluginEnabledOptions): Promise<PluginToggleResult> {
  const configPath = join(opts.root, 'config', 'lingcub.yaml')
  const overlayPath = join(opts.root, 'data', 'local.json')
  try {
    const config = loadConfigLayered(configPath, overlayPath)
    const installed = await rescanInstalled(opts.pluginDir ?? PLUGIN_DIR, config)
    const plugin = installed.find((p) => p.id === opts.id)
    if (!plugin) {
      return { applied: false, restartRequired: false, message: `插件 ${opts.id} 不在安装目录里，先装好再改开关` }
    }

    const plan = plugin.api === 'v2' ? planV2(config, plugin, opts.enabled) : planV1(config, plugin, opts.enabled)
    if (!plan.ok) return { applied: false, restartRequired: false, message: plan.message }

    writeOverlay(configPath, overlayPath, plan.patch)
    const restartRequired = needsRestart(plugin)
    const action = opts.enabled ? '已启用' : '已停用'
    const tail = restartRequired ? '，需要重启 Lingcub 生效' : '，插件声明热生效（activation=hot），按声明无需重启'
    return { applied: true, restartRequired, message: `${action} ${opts.id}（${plan.where}，写入 data/local.json）${tail}` }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { applied: false, restartRequired: false, message: `插件 ${opts.id} 开关未生效：${reason}` }
  }
}
