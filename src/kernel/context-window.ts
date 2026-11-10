/**
 * 上下文进度条的分母从哪来。
 *
 * 只能信 claude 自己：`~/.claude/settings.json` 的 `env` 里
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 就是自动压缩的触发线（终端状态栏 `(245k/500k)` 的分母是同一个数），
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 是模型硬上限。
 *
 * 为什么不按模型名推断：服务商是 CC Switch 换的，同一个模型名挂在不同 provider 上窗口并不一样，
 * 只有这份 env 是「这个窗口这一轮真正在用多少」。拿配置里的常量当分母会算出 122% → 满格 100%，
 * 与实际 49% 差了整整一倍（2026-11-10 用户报的就是这个）。
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 先自动压缩线，再模型硬上限：用户问「还剩多少」问的是前者。 */
const WINDOW_KEYS = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS']

function positiveInt(v: string | undefined): number | undefined {
  if (!v) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function claudeSettingsPath(home = homedir()): string {
  const dir = process.env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude')
  return join(dir, 'settings.json')
}

interface SettingsCache {
  path: string
  mtimeMs: number
  env: Record<string, string>
}

let settingsCache: SettingsCache | undefined

/** `~/.claude/settings.json` 的 `env` 段；按 mtime 缓存（每轮对话都会问一次）。 */
export function claudeSettingsEnv(path = claudeSettingsPath()): Record<string, string> {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return {}
  }
  if (settingsCache && settingsCache.path === path && settingsCache.mtimeMs === mtimeMs) {
    return settingsCache.env
  }
  const env: Record<string, string> = {}
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as { env?: Record<string, unknown> }
    for (const [k, v] of Object.entries(d?.env ?? {})) {
      if (typeof v === 'string' || typeof v === 'number') env[k] = String(v)
    }
  } catch {
    /* 读不到就空着，下面还有兜底 */
  }
  settingsCache = { path, mtimeMs, env }
  return env
}

/**
 * 分母。优先级：本进程 env（钩子进程由 claude 拉起，继承的就是窗口真值）
 * → `settings.json` 的 env（常驻进程自己跑时）
 * → `fallback`（`config.contextWindow`，默认 0 表示「不知道」）。
 *
 * 都没有就返回 undefined：宁可只显示 `245k`，也不拿猜的值画百分比。
 */
export function resolveContextWindow(
  fallback?: number,
  env: Record<string, string | undefined> = process.env,
  settingsPath?: string,
): number | undefined {
  for (const k of WINDOW_KEYS) {
    const n = positiveInt(env[k])
    if (n) return n
  }
  const fromFile = claudeSettingsEnv(settingsPath)
  for (const k of WINDOW_KEYS) {
    const n = positiveInt(fromFile[k])
    if (n) return n
  }
  return fallback && fallback > 0 ? fallback : undefined
}
