/**
 * Claude Code 的跨会话投递（照搬生产实现的协议，不自己造）：
 * 连命名管道 → auth 行 → user 信封行 → 400ms 后关闭。
 *
 * 两个坑（来自生产实现）：
 *   1. peerToken 会在 /compact、resume 时重签；拿旧 token 写管道不报错，对方静默丢弃。
 *      所以每次投递前都要以 Claude Code 的会话表为准重新读一次。
 *   2. /resume 会在同一进程留下作废的 sessionId 空壳；这里按 sessionId 精确匹配，
 *      匹配不到就明说，不猜。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

export interface LivePeer {
  socket: string
  token: string
  pid: number
  cwd?: string
}

/** 从会话表里找活会话的管道地址与 peerToken；找不到返回 null。 */
export function findLivePeer(sessionsDir: string, sessionId: string): LivePeer | null {
  let files: string[]
  try {
    files = readdirSync(sessionsDir)
  } catch {
    return null
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    let reg: Record<string, unknown>
    try {
      reg = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    // 注册表里是完整 uuid，而 `claude --bg` 只回前 8 位短 id，所以允许前缀匹配
    const regSid = String(reg['sessionId'] ?? '')
    if ((regSid !== sessionId && !regSid.startsWith(sessionId)) || typeof reg['messagingSocketPath'] !== 'string')
      continue
    const pid = Number(reg['pid'])
    const keyFile = files.find((k) => k.startsWith(`${pid}.`) && k.endsWith('.key'))
    if (!keyFile) return null
    try {
      const key = JSON.parse(readFileSync(join(sessionsDir, keyFile), 'utf8')) as { peerToken?: string }
      if (!key.peerToken) return null
      return {
        socket: reg['messagingSocketPath'],
        token: key.peerToken,
        pid,
        cwd: typeof reg['cwd'] === 'string' ? reg['cwd'] : undefined,
      }
    } catch {
      return null
    }
  }
  return null
}

export type PostResult = { ok: true } | { ok: false; why: string }

export interface PostOptions {
  /** 写完等多久再关连接：不等回复，排队交给 claude 自己的输入队列 */
  closeDelayMs?: number
  timeoutMs?: number
}

export function deliverToPeer(peer: LivePeer, text: string, opts: PostOptions = {}): Promise<PostResult> {
  const closeDelayMs = opts.closeDelayMs ?? 400
  const timeoutMs = opts.timeoutMs ?? 8000
  return new Promise<PostResult>((resolve) => {
    let done = false
    const finish = (r: PostResult): void => {
      if (done) return
      done = true
      resolve(r)
    }
    const client = connect(peer.socket, () => {
      client.write(JSON.stringify({ type: 'auth', token: peer.token }) + '\n')
      client.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
      setTimeout(() => {
        client.end()
        finish({ ok: true })
      }, closeDelayMs)
    })
    client.on('error', (e: Error) => finish({ ok: false, why: e.message }))
    const timer = setTimeout(() => {
      client.destroy()
      finish({ ok: false, why: `投递超时（${timeoutMs}ms）` })
    }, timeoutMs)
    timer.unref()
  })
}
