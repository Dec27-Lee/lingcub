/** dsh 执行器的共享实现：v1 端口和 v2 事件执行器共用。 */

import { createReadStream, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'
import { z } from 'zod'
import type { Executor, Handle, Log } from '../domain/ports.ts'
import type { Progress, Work } from '../domain/types.ts'
import { assertAllowedRoot } from '../domain/allow-root.ts'
import { discoverDshSessions, discoverDshWorkspaces } from './dsh-discover.ts'
import { textOf } from './json.ts'
import { runOnce, spawnLines, type LineProcess } from './spawn.ts'
import { assertNoPlaceholders, renderArgs } from './template.ts'

export const dshConfigSchema = z.object({
  binary: z.string().default('dsh'),
  allowRoots: z.array(z.string()).default([]),
  args: z.array(z.string()).default(['--profile', 'headless', '--json', '{{prompt}}']),
  timeoutMs: z.number().int().positive().default(600_000),
  postArgs: z
    .array(z.string())
    .default(['--profile', 'headless', '--json', '--session-id', '{{sessionId}}', '-']),
  postTimeoutMs: z.number().int().positive().default(120_000),
  /** #resume 只列这几天内有活动的会话 */
  resumeDays: z.number().int().positive().default(5),
  /** 会话文件多久内更新过算「在跑」；dsh 没有可读的状态，只能采样推断 */
  liveWindowMs: z.number().int().positive().default(90_000),
})

export type DshConfig = z.infer<typeof dshConfigSchema>

/** 会话转录按 `~/.dsh/sessions/<slug>/<sessionId>/session.v*.jsonl.zstd` 落盘（2026-11-09 本机实测） */
const dshSessionsRoot = (): string => join(homedir(), '.dsh', 'sessions')

/**
 * 转录首行的 session 头是否属于「用户自己开的窗口」。
 *
 * 子代理/编排进程也往同一处写会话，头里是 `origin:"subagent"` + `parentSession` + `delegationDepth:1`
 * （2026-11-09 实测 db64f7d5）：照单采纳会在多智能体场景里刷出一堆假窗口，
 * 和 claude 侧 sdk-cli 子进程被当成窗口是同一类事故。判定不出来的一律不采纳——宁缺勿滥。
 */
export function isUserWindowHeader(line: string): boolean {
  return headerInfo(line).userWindow
}

/**
 * 从转录首行读两件事：是不是用户窗口、这个会话是什么时候建的。
 *
 * `createdAt` 用来挡「翻旧会话」：dsh 没有窗口概念，只认「文件最近被写过」，
 * 于是把半年前建的会话翻开改写一行，也会被当成「刚打开的窗口」接进飞书
 * （2026-11-09：两个 11-04 建的会话被重新激活，刷出两个莫名其妙的话题）。
 */
export function headerInfo(line: string): { userWindow: boolean; createdAt?: number } {
  let head: unknown
  try {
    head = JSON.parse(line)
  } catch {
    return { userWindow: false }
  }
  if (typeof head !== 'object' || head === null) return { userWindow: false }
  const rec = head as Record<string, unknown>
  if (rec.type !== 'session') return { userWindow: false }
  const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : undefined
  if (rec.origin === 'subagent') return { userWindow: false, createdAt }
  const parent = rec.parentSession
  if (typeof parent === 'string' && parent.trim()) return { userWindow: false, createdAt }
  // 必须有 agentPreset：人开的会话（GUI 里选过的）一定有；程序化 headless 会话没有。
  // 2026-11-09 实测：TongClaw 的任务会话全是 depth:0、无 origin、无 parentSession，只有 preset 这一处不同，
  // 照单采纳会在群里刷出一堆「你是智能协作模式的主助手」这种莫名其妙的话题。
  const preset = rec.agentPreset
  if (typeof preset !== 'string' || !preset.trim()) return { userWindow: false, createdAt }
  return { userWindow: true, createdAt }
}

/**
 * 读转录首行。走流式解压：一条活会话的转录可能几十 MB（实测 28MB），
 * 只需要头一行却整份解压会把内存顶起来。
 */
async function readHeaderLine(file: string): Promise<string | undefined> {
  const stream = createReadStream(file).pipe(createZstdDecompress())
  let text = ''
  try {
    for await (const chunk of stream) {
      text += (chunk as Buffer).toString('utf8')
      const nl = text.indexOf('\n')
      if (nl >= 0) return text.slice(0, nl)
      // 头行不可能这么长：解压出来不是预期格式，别继续吃内存
      if (text.length > 64 * 1024) return undefined
    }
    return text.trim() ? text.trim() : undefined
  } catch {
    return undefined
  } finally {
    stream.destroy()
  }
}

/** 这个 dsh 会话是不是用户窗口；定位不到转录、解压失败、头不认识都算「不知道」→ 不采纳。 */
async function userWindowOf(sessionId: string): Promise<{ userWindow: boolean; createdAt?: number }> {
  const root = dshSessionsRoot()
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return { userWindow: false }
  }
  for (const slug of slugs) {
    const dir = join(root, slug, sessionId)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.startsWith('session.v'))
    } catch {
      continue
    }
    for (const f of files) {
      const line = await readHeaderLine(join(dir, f))
      if (line !== undefined) return headerInfo(line)
    }
  }
  return { userWindow: false }
}

const nowIso = (): string => new Date().toISOString()

function sessionIdOf(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const rec = parsed as Record<string, unknown>
  if (rec.type !== 'session' || typeof rec.sessionId !== 'string' || !rec.sessionId) return undefined
  return rec.sessionId
}

function scanFinal(stdout: string): { final: boolean; error?: string } {
  let final = false
  let error: string | undefined
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const rec = parsed as Record<string, unknown>
    if (rec.type === 'final') final = true
    else if (rec.type === 'error' && typeof rec.message === 'string') error = rec.message
  }
  return { final, error }
}

interface Tracked {
  proc: LineProcess
  progresses: Progress[]
  alive: () => boolean
}

export function createDshExecutor(cfg: DshConfig, log: Log): Executor {
  const running = new Map<string, Tracked>()

  return {
    async start(w: Work): Promise<Handle> {
      assertAllowedRoot(w.workspace, cfg.allowRoots)
      const args = renderArgs(cfg.args, { prompt: w.prompt, cwd: w.workspace })
      assertNoPlaceholders(args)
      const stdinTask = args.includes('-')
      if (!stdinTask && !cfg.args.some((a) => a.includes('{{prompt}}'))) {
        log('warn', 'dsh args 既没有 {{prompt}} 也没有 "-"，任务内容不会被传给 dsh')
      }

      const progresses: Progress[] = []
      let takeSession: ((id: string | null) => void) | null = null
      const sessionLine = new Promise<string | null>((resolve) => {
        takeSession = resolve
      })
      const settleSession = (id: string | null): void => {
        const take = takeSession
        takeSession = null
        take?.(id)
      }
      const gaveUp = setTimeout(() => settleSession(null), 5000)

      let exited = false
      const proc = spawnLines({
        binary: cfg.binary,
        args,
        cwd: w.workspace,
        input: stdinTask ? w.prompt : undefined,
        log,
        onStderr: (line) => log('debug', `stderr: ${line}`),
        onLine: (line) => {
          let text = line
          try {
            const parsed: unknown = JSON.parse(line)
            text = textOf(parsed) || line
            const id = sessionIdOf(parsed)
            if (id) settleSession(id)
          } catch {
            /* 非 JSON 行原样记录 */
          }
          progresses.push({ at: nowIso(), kind: 'output', text: text.slice(0, 1000) })
        },
        onExit: (code) => {
          exited = true
          settleSession(null)
          progresses.push(
            code === 0
              ? { at: nowIso(), kind: 'finished' }
              : { at: nowIso(), kind: 'error', text: `进程退出码 ${code}` },
          )
        },
      })
      const real = await sessionLine
      clearTimeout(gaveUp)
      const sessionId = real ?? w.id
      if (!real) log('warn', `dsh 没在 5 秒内给出 session id，回退 ${w.id}（追加会因 id 不存在失败）`)
      running.set(sessionId, { proc, progresses, alive: () => !exited })
      log('info', `dsh 任务已起：${sessionId}`)
      return { executor: 'dsh', sessionId, workspace: w.workspace }
    },

    async read(h: Handle): Promise<Progress[]> {
      return running.get(h.sessionId)?.progresses ?? []
    },

    async listSessions() {
      return discoverDshSessions({
        roots: cfg.allowRoots,
        maxAgeDays: cfg.resumeDays,
        liveWindowMs: cfg.liveWindowMs,
      })
    },

    async listLiveSessions() {
      const live = discoverDshSessions({
        roots: cfg.allowRoots,
        maxAgeDays: cfg.resumeDays,
        liveWindowMs: cfg.liveWindowMs,
      }).filter((s) => s.running)
      // 活会话里混着子代理/编排进程：按转录头剔掉，免得采纳链路把它们当成用户窗口接进飞书
      const out: ((typeof live)[number] & { createdAt?: number })[] = []
      for (const s of live) {
        const info = await userWindowOf(s.sessionId)
        if (info.userWindow) out.push({ ...s, createdAt: info.createdAt })
      }
      return out
    },

    async listWorkspaces() {
      return discoverDshWorkspaces({
        roots: cfg.allowRoots,
        maxAgeDays: cfg.resumeDays,
        liveWindowMs: cfg.liveWindowMs,
      })
    },

    async stop(h: Handle): Promise<void> {
      const tracked = running.get(h.sessionId)
      if (!tracked) return
      await tracked.proc.stop()
    },

    async post(h: Handle, text: string): Promise<void> {
      const tracked = running.get(h.sessionId)
      if (tracked?.alive()) throw new Error(`会话 ${h.sessionId} 还在跑，不能追加（dsh 的追加是串行的：跑完这轮再发）`)
      const args = renderArgs(cfg.postArgs, { sessionId: h.sessionId })
      assertNoPlaceholders(args)
      const r = await runOnce({
        binary: cfg.binary,
        args,
        cwd: h.workspace,
        input: text,
        timeoutMs: cfg.postTimeoutMs,
      })
      const scanned = scanFinal(r.stdout)
      if (r.code !== 0) {
        throw new Error(`dsh 追加失败（exit=${r.code}）：${(r.stderr.trim() || scanned.error || '').slice(0, 300)}`)
      }
      if (!scanned.final) {
        throw new Error(
          `dsh 追加没有 final 行（exit=0 但这一轮没收尾）：${(scanned.error || r.stderr.trim() || r.stdout.trim()).slice(0, 300)}`,
        )
      }
      log('info', `已追加到会话 ${h.sessionId}`)
    },
  }
}
