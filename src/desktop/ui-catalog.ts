/**
 * 桌面面板的插件 UI 贡献目录。
 *
 * 插件目录放一个 ui.json：
 * {
 *   "nav":  [{"id":"main","label":"分析","page":"index.html"}],
 *   "slots":[{"slot":"main.header","page":"header.html","height":48}]
 * }
 * 页面文件只允许落在插件自己的 ui/ 目录内；宿主只提供静态 iframe，不把插件 HTML 拼进主页面。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { z } from 'zod'

const NavItem = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    page: z.string().min(1),
    order: z.number().optional(),
  })
  .strict()

const SlotItem = z
  .object({
    slot: z.string().min(1),
    page: z.string().min(1),
    height: z.number().int().positive().max(600).default(120),
  })
  .strict()

const Manifest = z
  .object({
    nav: z.array(NavItem).default([]),
    slots: z.array(SlotItem).default([]),
  })
  .strict()

export interface UiNav {
  pluginId: string
  id: string
  label: string
  page: string
  url: string
  order?: number
}

export interface UiSlot {
  pluginId: string
  slot: string
  page: string
  url: string
  height: number
}

export interface UiCatalog {
  nav: UiNav[]
  slots: UiSlot[]
  errors: string[]
}

function safePage(page: string): boolean {
  if (!page || page.startsWith('/') || page.startsWith('\\') || page.includes('..')) return false
  return page.endsWith('.html')
}

const ASSET_RE = /\.(html|css|js|svg|png|jpe?g|webp|woff2?)$/i

function uiFile(pluginDir: string, pluginId: string, page: string): string | null {
  if (!safePage(page)) return null
  const base = resolve(pluginDir, pluginId, 'ui')
  const path = resolve(base, page)
  if (path !== base && !path.startsWith(base + sep)) return null
  try {
    return existsSync(path) && statSync(path).isFile() ? path : null
  } catch {
    return null
  }
}

export function discoverUi(pluginDir: string, enabled: ReadonlySet<string>): UiCatalog {
  const nav: UiNav[] = []
  const slots: UiSlot[] = []
  const errors: string[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(pluginDir).filter((name) => {
      try {
        return statSync(resolve(pluginDir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return { nav, slots, errors: [`插件目录不可读：${pluginDir}`] }
  }
  for (const pluginId of dirs) {
    if (!enabled.has(pluginId)) continue
    const path = resolve(pluginDir, pluginId, 'ui.json')
    if (!existsSync(path)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch (e) {
      errors.push(`${pluginId}: ui.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const parsed = Manifest.safeParse(raw)
    if (!parsed.success) {
      errors.push(`${pluginId}: ui.json 不合规：${parsed.error.issues[0]?.message ?? '未知'}`)
      continue
    }
    for (const item of parsed.data.nav) {
      if (!uiFile(pluginDir, pluginId, item.page)) {
        errors.push(`${pluginId}: 导航页不存在或路径非法：${item.page}`)
        continue
      }
      nav.push({
        pluginId,
        ...item,
        url: `/plugin-ui/${encodeURIComponent(pluginId)}/${item.page}`,
      })
    }
    for (const item of parsed.data.slots) {
      if (!uiFile(pluginDir, pluginId, item.page)) {
        errors.push(`${pluginId}: 插槽页不存在或路径非法：${item.page}`)
        continue
      }
      slots.push({
        pluginId,
        ...item,
        url: `/plugin-ui/${encodeURIComponent(pluginId)}/${item.page}`,
      })
    }
  }
  nav.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label))
  return { nav, slots, errors }
}

/** 静态页面读取；只返回 ui/ 下的 .html，防止路径穿越。 */
export function readUiPage(
  pluginDir: string,
  pluginId: string,
  page: string,
): { path: string; body: string } | null {
  const path = uiFile(pluginDir, pluginId, page)
  if (!path) return null
  try {
    return { path, body: readFileSync(path, 'utf8') }
  } catch {
    return null
  }
}

export function readUiAsset(
  pluginDir: string,
  pluginId: string,
  page: string,
): { path: string; body: Buffer } | null {
  if (!page || page.startsWith('/') || page.startsWith('\\') || page.includes('..')) return null
  if (!ASSET_RE.test(page)) return null
  const base = resolve(pluginDir, pluginId, 'ui')
  const path = resolve(base, page)
  if (path !== base && !path.startsWith(base + sep)) return null
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    return { path, body: readFileSync(path) }
  } catch {
    return null
  }
}
