/**
 * 面板的插件清单与开关。
 *
 * 清单只读：发现（v1/v2 目录都扫）≠ 启用，停用/未配置的插件也要看得见，台账直接复用
 * kernel/plugin-v2/catalog。开关本身不在这里实现——写配置要动覆盖层、要判断 v1 旧段还是
 * v2 段，那是 kernel/plugin-v2/plugin-admin.ts 的事。
 */

import { resolve } from 'node:path'
import { loadConfigLayered } from '../kernel/config.ts'
import { discoverPlugins } from '../kernel/registry.ts'
import { discoverPluginsV2 } from '../kernel/plugin-v2/index.ts'
import { installedPlugins, type InstalledPlugin } from '../kernel/plugin-v2/catalog.ts'
import { setPluginEnabled, type PluginToggleResult } from '../kernel/plugin-v2/plugin-admin.ts'
import { PLUGIN_DIR } from '../kernel/wiring.ts'

export interface PluginStatuses {
  installed: InstalledPlugin[]
  /** 已启用插件 id（installed 的子集） */
  enabled: string[]
  /** 停用或从未配置的插件 id（installed 的子集） */
  disabled: string[]
}

/** 未知插件：面板据此回 400，而不是把「没这个插件」当内部错误。 */
export class UnknownPluginError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`插件 ${id} 未安装`)
    this.name = 'UnknownPluginError'
    this.id = id
  }
}

/**
 * 已安装插件台账 + 启用/停用 id 列表。
 * `pluginDir` 缺省是仓库的 `src/plugins`（编译后 `dist/plugins`），测试可指向临时目录。
 */
export async function pluginStatuses(root: string, pluginDir: string = PLUGIN_DIR): Promise<PluginStatuses> {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const [v1, v2] = await Promise.all([discoverPlugins(pluginDir), discoverPluginsV2(pluginDir)])
  const installed = installedPlugins(v1, v2, config)
  return {
    installed,
    enabled: installed.filter((p) => p.enabled).map((p) => p.id),
    disabled: installed.filter((p) => !p.enabled).map((p) => p.id),
  }
}

/**
 * 开关一个插件：先确认它确实装上了（未知 id 直接抛 UnknownPluginError → 面板回 400），
 * 再交给 plugin-admin 写覆盖层。plugin-admin 自己失败时返回 applied:false + message，不抛。
 */
export async function togglePlugin(root: string, id: string, enabled: boolean): Promise<PluginToggleResult> {
  const statuses = await pluginStatuses(root)
  if (!statuses.installed.some((p) => p.id === id)) throw new UnknownPluginError(id)
  return setPluginEnabled({ root, id, enabled })
}
