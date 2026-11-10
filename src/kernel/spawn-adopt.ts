/**
 * 一次性导入：把**本轮之前**产生的一次性会话转录补登记进 `spawned_sessions`。
 *
 * 为什么要单独一条路：从 2026-11-09 起，`runClaudeOnce` 会把自己拿到的会话 id 记进库；
 * 在那之前的转录没有记录。用户要求「按 id 删，不做内容匹配」，所以这里只在**导入这一步**
 * 用一次判据，把 id 认出来落库；之后的删除仍然只认表里的 id。
 *
 * 判据（优先级从高到低，任一命中即定性）：
 *   1. 平台元数据 `entrypoint`：`sdk-cli` = 编程式一次性调用；`cli` = 用户在终端开的窗口。
 *   2. 我们拼给模型的任务模板里那两个固定小标题（`## 候选项目` / `## 当前消息`）——
 *      比首句文案稳：提示词改过几轮，模板没改。
 *
 * 两条都在还不算我们的（比如手工跑的探针）：`sdkCliUnmarked`，**不进清单**。
 * 没有 `entrypoint` 的（旧格式）`: unknown`，也不进清单。
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 我们拼任务时写死的两个小标题，分类与分析的模板各一个。 */
export const TASK_MARKERS = ['## 候选项目', '## 当前消息'] as const

/** 只看头部：`entrypoint` 与第一条 user 内容都在前几十 KB 里。 */
const HEAD_BYTES = 64 * 1024

export interface SpawnCandidate {
  sessionId: string
  bytes: number
  /** 转录最后写入时间：导入时用它当「这次调用真正发生的时间」，TTL 才按实际算 */
  mtimeMs: number
}

export interface AdoptScan {
  /** 认定为「本平台发起的一次性调用」：可以登记 */
  adopt: SpawnCandidate[]
  /** 有 sdk-cli 元数据，但没有我们的模板标记（手工探针、别的工具） */
  sdkCliUnmarked: SpawnCandidate[]
  /** 平台元数据说是交互式会话：用户自己开的窗口 */
  interactive: SpawnCandidate[]
  /** 认不出来（旧格式） */
  unknown: SpawnCandidate[]
}

function readHead(file: string, size: number): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES))
    readSync(fd, buf, 0, buf.length, 0)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** 扫一个 claude projects 目录，按判据分类（纯读，不改任何东西）。 */
export function scanSpawnTranscripts(projectsDir: string): AdoptScan {
  const out: AdoptScan = { adopt: [], sdkCliUnmarked: [], interactive: [], unknown: [] }
  let subs: string[]
  try {
    subs = readdirSync(projectsDir)
  } catch {
    return out
  }
  for (const sub of subs) {
    const dir = join(projectsDir, sub)
    let names: string[]
    try {
      if (!statSync(dir).isDirectory()) continue
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      let size: number
      try {
        size = statSync(file).size
      } catch {
        continue
      }
      const head = readHead(file, size)
      const candidate: SpawnCandidate = {
        sessionId: name.slice(0, -'.jsonl'.length),
        bytes: size,
        mtimeMs: statSync(file).mtimeMs,
      }
      const ep = head.match(/"entrypoint"\s*:\s*"([^"]+)"/)?.[1]
      const marked = TASK_MARKERS.some((m) => head.includes(m))
      if (ep === 'sdk-cli') {
        ;(marked ? out.adopt : out.sdkCliUnmarked).push(candidate)
      } else if (ep) {
        out.interactive.push(candidate)
      } else {
        out.unknown.push(candidate)
      }
    }
  }
  return out
}

export function totalBytes(list: readonly SpawnCandidate[]): number {
  return list.reduce((n, c) => n + c.bytes, 0)
}
