/**
 * 工作区信任预置：Claude Code 第一次在某个目录里启动会弹
 * 「Is this a project you created…? Yes, I trust this folder」，没人按键盘它就永远停在那，
 * 我们的 SessionStart 注册也永远等不到——表现就是「窗口起来了但投不进去」。
 *
 * 官方把这个选择记在 `~/.claude.json` 的 `projects[<绝对路径>].hasTrustDialogAccepted`。
 * 只写这一个键：不动别人的项目条目、不动其它字段；写前留一份备份，写坏可回滚。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface TrustFile {
  path: string
}

export function defaultTrustFile(): TrustFile {
  return { path: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '..', '.claude.json') }
}

interface ClaudeJson {
  projects?: Record<string, Record<string, unknown>>
  [k: string]: unknown
}

/**
 * 确保 cwd 被标记为「已信任」。返回是否真的改了文件。
 * 文件不存在/解析失败时**不新建、不猜测**：抛错让上层决定（默认不让开窗静默失败）。
 */
export function ensureTrusted(cwd: string, file: TrustFile = defaultTrustFile()): boolean {
  const abs = resolve(cwd)
  // 命中 git 仓库时，Claude Code 记的是**仓库根**那条（参考项目 lib.js 的 needsTrustPrompt 口径）
  const gitRoot = gitRootOf(abs)
  const keys = gitRoot && gitRoot.toLowerCase() !== abs.toLowerCase() ? [abs, gitRoot] : [abs]
  if (!existsSync(file.path)) throw new Error(`找不到 Claude Code 配置：${file.path}（先手动跑一次 claude）`)
  let parsed: ClaudeJson
  try {
    parsed = JSON.parse(readFileSync(file.path, 'utf8')) as ClaudeJson
  } catch (e) {
    throw new Error(`解析 ${file.path} 失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const projects = { ...(parsed.projects ?? {}) }
  let changed = false
  for (const target of keys) {
    // 同一个目录可能以 `E:/a` 或 `E:\a` 两种写法登记：两种都要认
    const existingKey = Object.keys(projects).find((k) => samePath(k, target))
    const key = existingKey ?? trustKey(target)
    const entry = projects[key] ?? {}
    if (entry['hasTrustDialogAccepted'] === true) continue
    projects[key] = { ...entry, hasTrustDialogAccepted: true }
    changed = true
  }
  if (!changed) return false
  const next: ClaudeJson = { ...parsed, projects }
  const backup = `${file.path}.bak-lingcub`
  copyFileSync(file.path, backup)
  const tmp = `${file.path}.tmp-lingcub`
  writeFileSync(tmp, JSON.stringify(next), 'utf8')
  renameSync(tmp, file.path)
  return true
}

/** 往上找 git 仓库根（找不到就 null）。 */
export function gitRootOf(dir: string): string | null {
  let cur = resolve(dir)
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(cur, '.git'))) return cur
    const up = resolve(cur, '..')
    if (up === cur) return null
    cur = up
  }
  return null
}

export interface TrustStatus {
  /** true = 开窗不会再弹信任确认 */
  trusted: boolean
  /** 判定用的那条记录（git 根或目录本身） */
  key: string
}

/**
 * 开窗前会不会弹信任确认——照参考项目 `lib.js:355 needsTrustPrompt` 的口径：
 * 已登记（git 根优先）→ 不弹；没登记时只有「带需要批准的配置」（git 仓库 / .claude 设置 / .mcp.json）
 * 才会弹，纯文件夹直接进；家目录永远要确认。
 */
export function trustStatus(dir: string, file: TrustFile = defaultTrustFile()): TrustStatus {
  const abs = resolve(dir)
  if (abs.toLowerCase() === resolve(homedir()).toLowerCase()) return { trusted: false, key: abs }
  const root = gitRootOf(abs)
  const key = root ?? abs
  let trusted = false
  try {
    const parsed = JSON.parse(readFileSync(file.path, 'utf8')) as ClaudeJson
    trusted = Object.entries(parsed.projects ?? {}).some(
      // 键可能是 `E:/a/b`（Claude 自己写的）也可能是我早先写的 `E:\a\b`：两种都认
      ([k, v]) => samePath(k, key) && v?.['hasTrustDialogAccepted'] === true,
    )
  } catch {
    /* 读不到就当没信任过：宁可多提示一次，也不要让用户以为窗口坏了 */
  }
  if (trusted) return { trusted: true, key }
  if (!root) {
    const needs =
      existsSync(join(abs, '.claude', 'settings.json')) ||
      existsSync(join(abs, '.claude', 'settings.local.json')) ||
      existsSync(join(abs, '.mcp.json'))
    return { trusted: !needs, key }
  }
  return { trusted: false, key }
}
/**
 * Claude Code 记项目路径用的是**正斜杠**写法（实测 `~/.claude.json`：
 * `E:/Develop_E/lingcub`，而 `E:\Develop_E\...\updatesql` 这种反斜杠条目它不认）。
 * 所以写的键、比对都要按正斜杠来。
 */
export function trustKey(dir: string): string {
  const abs = resolve(dir)
  const slashed = abs.replace(/\\/g, '/')
  // 盘符统一大写（实测条目都是 `E:/...`）
  return slashed.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`)
}

/** 两个路径字符串说的是不是同一个目录（分隔符、盘符大小写都不计较）。 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^([a-z]):/i, (_m, d: string) => `${d.toUpperCase()}:`).toLowerCase()
  return norm(a) === norm(b)
}
