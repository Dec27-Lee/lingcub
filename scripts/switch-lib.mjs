/**
 * 切换/回滚脚本里可以单测的那几块（其余部分一碰就是真进程，没法在测试里跑）。
 */

import { existsSync, readFileSync } from 'node:fs'

/** 读 lingcub 的锁文件：正常情况下就是一个 pid 数字，老版本曾写过 JSON。 */
export function readLockPid(file) {
  if (!existsSync(file)) return null
  const raw = readFileSync(file, 'utf8').trim()
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  try {
    const j = JSON.parse(raw)
    return typeof j.pid === 'number' ? j.pid : null
  } catch {
    return null
  }
}

/**
 * 切换时「该停谁」的判定（纯函数，测试能直接喂进程表进来）。
 *
 * 三条规矩：
 *   1. 看门狗必须先停——它会把你刚停掉的旧桥接重新拉起来；
 *   2. 自己的消费进程（lingcub → node 包装 → lark-cli 这条链上的）一个都不动；
 *   3. 别人（旧桥接）的消费进程才停。
 *
 * @param consumers [{ pid, parent }] 进程表里的 event consume
 * @param watchdogs [{ pid }] 旧桥接的看门狗
 * @param lingcubPid lingcub 常驻的 pid（没在跑就是 null）
 */
export function planSwitch({ consumers = [], watchdogs = [], lingcubPid = null } = {}) {
  const oursIds = new Set(lingcubPid ? [lingcubPid] : [])
  let grew = true
  while (grew) {
    grew = false
    for (const c of consumers) {
      if (oursIds.has(c.pid)) continue
      if (oursIds.has(c.parent)) {
        oursIds.add(c.pid)
        grew = true
      }
    }
  }
  return {
    watchdogPids: watchdogs.map((d) => d.pid),
    ourConsumers: consumers.filter((c) => oursIds.has(c.pid)).map((c) => c.pid),
    theirConsumers: consumers.filter((c) => !oursIds.has(c.pid)).map((c) => c.pid),
  }
}

/**
 * 回滚之后该核对什么（给一段人能直接照着敲的检查，而不是「应该好了」）。
 */
export function rollbackChecklist({ lingcubPid, consumers = [] }) {
  const steps = []
  steps.push(lingcubPid ? `1) 确认 lingcub 已退出：进程表里没有 pid ${lingcubPid}` : '1) lingcub 本来就没在跑')
  steps.push(`2) 确认旧桥接的消费进程回来了：现在 ${consumers.length} 个 event consume`)
  steps.push('3) 在飞书里发一条消息，确认旧桥接仍能应答（这一步只能人来判）')
  return steps
}
