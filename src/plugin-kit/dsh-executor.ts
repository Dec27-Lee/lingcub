/** dsh 执行器的共享实现：v1 端口和 v2 事件执行器共用。 */

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
      return discoverDshSessions({
        roots: cfg.allowRoots,
        maxAgeDays: cfg.resumeDays,
        liveWindowMs: cfg.liveWindowMs,
      }).filter((s) => s.running)
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
