/** 面板实例登记：让「再点一次入口」复用已跑的面板，而不是堆出第二个服务。 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface UiInfo {
  port: number
  token: string
  pid: number
  url: string
}

export function uiInfoPath(root: string): string {
  return resolve(root, 'data/ui.json')
}

export function readUiInfo(root: string): UiInfo | null {
  const file = uiInfoPath(root)
  if (!existsSync(file)) return null
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<UiInfo>
    if (typeof v.port !== 'number' || typeof v.token !== 'string' || typeof v.pid !== 'number') return null
    return { port: v.port, token: v.token, pid: v.pid, url: `http://127.0.0.1:${v.port}/?t=${v.token}` }
  } catch {
    return null
  }
}

export function writeUiInfo(root: string, info: UiInfo): void {
  const file = uiInfoPath(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(info, null, 2) + '\n', 'utf8')
}

/** 只删自己写的那份：避免把别的实例（另一个数据目录）的登记删掉。 */
export function clearUiInfo(root: string, pid = process.pid): void {
  const info = readUiInfo(root)
  if (!info || info.pid !== pid) return
  try {
    unlinkSync(uiInfoPath(root))
  } catch {
    /* 已经没了 */
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 有登记且进程还活着，才算「已经在跑」。 */
export function findRunningUi(root: string): UiInfo | null {
  const info = readUiInfo(root)
  if (!info || !pidAlive(info.pid)) return null
  return info
}
