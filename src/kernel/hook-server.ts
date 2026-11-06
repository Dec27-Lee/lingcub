/**
 * 本地 hook 端点：给 claude 的 Stop / Notification 钩子一个落脚处。
 *
 * 钩子是从 claude 那边被调起的独立进程，它不认我们的端口，所以端口与令牌写在
 * `data/hooks.json` 里，由 `lingcub hook post` 读出来再转发——端口变了也不用改钩子配置。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface HookInfo {
  port: number
  token: string
  pid: number
}

export interface HookPayload {
  session_id?: string
  cwd?: string
  last_assistant_message?: string
  message?: string
  transcript_path?: string
  /** 通知类型（Notification 事件带）：permission / idle / question / input … */
  notification_type?: string
  [k: string]: unknown
}

export function hookInfoPath(root: string): string {
  return resolve(root, 'data/hooks.json')
}

export function readHookInfo(root: string): HookInfo | null {
  const file = hookInfoPath(root)
  if (!existsSync(file)) return null
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<HookInfo>
    if (typeof v.port !== 'number' || typeof v.token !== 'string' || typeof v.pid !== 'number') return null
    return { port: v.port, token: v.token, pid: v.pid }
  } catch {
    return null
  }
}

function writeHookInfo(root: string, info: HookInfo): void {
  const file = hookInfoPath(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(info, null, 2) + '\n', 'utf8')
}

function clearHookInfo(root: string, pid: number): void {
  const info = readHookInfo(root)
  if (!info || info.pid !== pid) return
  try {
    unlinkSync(hookInfoPath(root))
  } catch {
    /* 已经没了 */
  }
}

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolveP, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

export interface HookServerOptions {
  root: string
  /** 一轮结束：把结果送回话题 */
  onStop: (p: HookPayload) => Promise<void>
  /** 需要人介入：推提醒 */
  onNotify?: (p: HookPayload) => Promise<void>
  /** 钩子处理出错时写进主日志：改成 400 之后，错误只回到调用方，主日志一片空白（2026-11-06 丢了一整轮回复就是这样） */
  log?: (level: 'warn', msg: string) => void

  /** 有新东西入队时催一次投递，别等主循环下一拍（一轮结束的回复最要紧） */
  kick?: () => void

  /** 会话开头：返回 additionalContext（注入到模型的上下文里） */
  onSessionStart?: (p: HookPayload) => Promise<Record<string, unknown>>
  /** 选择题：挂起等作答，返回钩子该输出的 JSON（空对象=不代答，终端弹窗照常出现） */
  onAsk?: (p: HookPayload) => Promise<Record<string, unknown>>
  /** 工具授权：同样挂起等作答 */
  onPermission?: (p: HookPayload) => Promise<Record<string, unknown>>
  port?: number
}

export interface HookServerHandle {
  port: number
  token: string
  close: () => Promise<void>
}

export async function startHookServer(opts: HookServerOptions): Promise<HookServerHandle> {
  const token = randomBytes(16).toString('hex')
  let closed = false

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz') return send(res, 200, '{"ok":true}')
    if (url.searchParams.get('t') !== token) return send(res, 403, '{"ok":false,"error":"令牌无效"}')
    if (req.method !== 'POST') return send(res, 405, '{"ok":false,"error":"只收 POST"}')

    void readBody(req)
      .then(async (raw) => {
        const payload = (raw.trim() ? JSON.parse(raw) : {}) as HookPayload
        if (url.pathname === '/stop') {
          await opts.onStop(payload)
          // 立刻催一次投递：实测等主循环下一拍要多花十几秒（那一拍还在跑分析、刷卡片）
          try {
            opts.kick?.()
          } catch {
            /* 催不动就等下一拍 */
          }
          return send(res, 200, '{"ok":true}')
        }
        if (url.pathname === '/permission') {
          const decision = (await opts.onPermission?.(payload)) ?? {}
          return send(res, 200, JSON.stringify(decision))
        }
        if (url.pathname === '/ask') {
          const decision = (await opts.onAsk?.(payload)) ?? {}
          return send(res, 200, JSON.stringify(decision))
        }
        if (url.pathname === '/notify') {
          await opts.onNotify?.(payload)
          return send(res, 200, '{"ok":true}')
        }
        if (url.pathname === '/session-start') {
          // 会话开头注入「飞书远程输入约定」：让模型知道信封里的那条消息是用户本人打的
          const extra = (await opts.onSessionStart?.(payload)) ?? {}
          return send(res, 200, JSON.stringify(extra))
        }
        send(res, 404, '{"ok":false,"error":"未知路径"}')
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        opts.log?.('warn', `钩子处理失败（${new URL(req.url ?? '/', 'http://x').pathname}）：${msg}`)
        send(res, 400, JSON.stringify({ ok: false, error: msg }))
      })
  })

  await new Promise<void>((r, j) => {
    server.once('error', j)
    server.listen(opts.port ?? 0, '127.0.0.1', () => r())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0)
  writeHookInfo(opts.root, { port, token, pid: process.pid })

  return {
    port,
    token,
    close: async () => {
      if (closed) return
      closed = true
      clearHookInfo(opts.root, process.pid)
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
