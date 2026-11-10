/**
 * Claude Code 执行器的共享实现：v1 端口和 v2 事件执行器共用。
 *
 * 这里只负责“后台会话 + 观测 + 投递 + 止损”；终端开窗属于 v2 执行器插件，
 * 因为它依赖平台启动器（Windows VBS/wt），不是每个入口都需要。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Executor, Handle, Log } from '../domain/ports.ts'
import type { Progress, Work } from '../domain/types.ts'
import { assertAllowedRoot } from '../domain/allow-root.ts'
import { deliverToPeer, findLivePeer } from './claude-pipe.ts'
import {
  discover,
  discoverLiveSessions,
  discoverSessions,
  liveFromAgents,
  parseAgentsJson,
  type SessionHistory,
} from './claude-discover.ts'
import { ensureTrusted, trustStatus } from './claude-trust.ts'
import { keepUserWindows } from './internal-claude.ts'
import { assertNoPlaceholders, renderArgs } from './template.ts'
import { runOnce } from './spawn.ts'

export const claudeConfigSchema = z.object({
  binary: z.string().default('claude'),
  /** 第二道门禁：路由层已经查过，插件层再查一次，配置错就起不来 */
  allowRoots: z.array(z.string()).default([]),
  // 实测（claude 2.1.317）：`--bg` 与 `-p/--print` 冲突，提示词必须是位置参数；
  // 而且 `--bg` 不接受 `--session-id` 预设（会另起一个新的），会话短 id 只能从输出里读。
  args: z.array(z.string()).default([
    '--bg',
    '--permission-mode',
    'bypassPermissions',
    '--max-budget-usd',
    '{{budgetUsd}}',
    '--max-turns',
    '{{maxTurns}}',
    '{{prompt}}',
  ]),
  defaultBudgetUsd: z.number().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  /** 额外声明的目录：即使 claude 从没在里面开过会话，也列进选择卡 */
  launchWorkspaces: z.array(z.string()).default([]),
  /** #resume 只列这几天内有活动的会话 */
  resumeDays: z.number().int().positive().default(5),
  /** 官方列举入口；CLI 版本不支持时自动退回读注册表 */
  agentsArgs: z.array(z.string()).default(['agents', '--json']),
  /** 观测命令，例如 ['logs', '{{sessionId}}']；不配就观测不到进度 */
  logsArgs: z.array(z.string()).optional(),
  /** 输出里命中该正则即视为完成 */
  finishedPattern: z.string().optional(),
  stopArgs: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().default(120_000),
  /** Claude Code 的会话表目录；空则用 ~/.claude/sessions */
  sessionsDir: z.string().default(''),
  /** 投递后等多久关连接（不打断运行中的一轮，排队交给 claude 输入队列） */
  postCloseDelayMs: z.number().int().positive().default(400),
  postTimeoutMs: z.number().int().positive().default(8000),
})

export type ClaudeConfig = z.infer<typeof claudeConfigSchema>

const nowIso = (): string => new Date().toISOString()

export function createClaudeExecutor(cfg: ClaudeConfig, log: Log): Executor {
  const sessionsDir = (): string => cfg.sessionsDir || join(homedir(), '.claude', 'sessions')

  return {
    async start(w: Work): Promise<Handle> {
      assertAllowedRoot(w.workspace, cfg.allowRoots)

      const budgetUsd = w.budgetUsd ?? cfg.defaultBudgetUsd
      if (budgetUsd === undefined) throw new Error('未配置预算：executor-claude.defaultBudgetUsd 或 Work.budgetUsd')

      const sessionId = randomUUID()
      const vars: Record<string, string> = {
        prompt: w.prompt,
        sessionId,
        cwd: w.workspace,
        budgetUsd: String(budgetUsd),
      }
      if (cfg.maxTurns !== undefined) vars.maxTurns = String(cfg.maxTurns)

      const args = renderArgs(cfg.args, vars)
      assertNoPlaceholders(args)
      if (w.resumeSessionId) {
        // `--resume <id>` 放在位置参数（提示词）之前；实测 `--bg --resume` 可用
        args.splice(args.length - 1, 0, '--resume', w.resumeSessionId)
      }

      const r = await runOnce({ binary: cfg.binary, args, cwd: w.workspace, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) {
        throw new Error(`claude 启动失败（exit=${r.code}）：${r.stderr.trim().slice(0, 300)}`)
      }
      // `--bg` 只回一行「backgrounded · af74099e」，真正的会话 id 由 claude 自己定
      const shortId = /backgrounded\s*[·:]\s*([0-9a-f]{6,})/i.exec(r.stdout)?.[1]
      if (!shortId) {
        throw new Error(`claude 没有返回后台会话 id（输出：${r.stdout.trim().slice(0, 200)}）`)
      }
      log('info', `claude 会话已起：${shortId}（本地预生成 ${sessionId} 未使用：--bg 不接受预设 id）`)
      return { executor: 'claude', sessionId: shortId, workspace: w.workspace }
    },

    async listSessions() {
      return discoverSessions({ roots: cfg.allowRoots, maxAgeDays: cfg.resumeDays })
    },

    async listLiveSessions() {
      // 平台自己的摘要/分类子进程也是 claude 会话，但它们是「一次调用」不是「用户的窗口」：
      // 混进来就会被接进飞书建话题、置顶，还会把 JSON 结果当窗口回复推出去。
      // 两道闸：本次进程登记的（内存）+ 转录里的一次性调用标记（跨进程，重启也认）
      const userWindows = (list: SessionHistory[]): SessionHistory[] => keepUserWindows(list)
      // 首选官方列举：带全 uuid 与 busy/idle，用户自己在终端开的会话也在里面
      try {
        const r = await runOnce({
          binary: cfg.binary,
          args: cfg.agentsArgs,
          timeoutMs: Math.min(cfg.timeoutMs, 20_000),
        })
        if (r.code === 0) {
          const agents = parseAgentsJson(r.stdout)
          if (agents.length) {
            return userWindows(liveFromAgents(agents, { roots: cfg.allowRoots, maxAgeDays: cfg.resumeDays }))
          }
        }
      } catch {
        /* 落回注册表 */
      }
      return userWindows(await discoverLiveSessions({ roots: cfg.allowRoots, maxAgeDays: cfg.resumeDays }))
    },

    async listWorkspaces() {
      // 带上「首次会不会弹信任确认」：列表里标出来，并把要确认的排到后面
      return discover({ roots: cfg.allowRoots, extra: cfg.launchWorkspaces ?? [] }).map((w) => ({
        ...w,
        trusted: trustStatus(w.root).trusted,
      }))
    },

    /** 用户点了这个工作区 = 他信任这个目录：直接写进 Claude Code 的信任记录。 */
    async trustWorkspace(root: string) {
      if (trustStatus(root).trusted) return { trusted: true, changed: false }
      let changed = false
      try {
        changed = ensureTrusted(root)
      } catch (e) {
        log('warn', `信任登记失败（窗口可能仍会问一次）：${e instanceof Error ? e.message : String(e)}`)
        return { trusted: false, changed: false }
      }
      const trusted = trustStatus(root).trusted
      if (trusted) log('info', `已登记工作区信任：${root}`)
      return { trusted, changed }
    },

    async read(h: Handle): Promise<Progress[]> {
      if (!cfg.logsArgs) {
        log('debug', '未配置 logsArgs，观测不到进度')
        return []
      }
      const args = renderArgs(cfg.logsArgs, { sessionId: h.sessionId })
      assertNoPlaceholders(args)
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) {
        return [{ at: nowIso(), kind: 'error', text: r.stderr.trim().slice(0, 500) || `exit=${r.code}` }]
      }
      const out: Progress[] = [{ at: nowIso(), kind: 'output', text: r.stdout.trim().slice(-2000) }]
      if (cfg.finishedPattern && new RegExp(cfg.finishedPattern).test(r.stdout)) {
        out.push({ at: nowIso(), kind: 'finished' })
      }
      return out
    },

    async stop(h: Handle): Promise<void> {
      if (!cfg.stopArgs) {
        log('warn', '未配置 stopArgs，无法止损')
        return
      }
      const args = renderArgs(cfg.stopArgs, { sessionId: h.sessionId })
      assertNoPlaceholders(args)
      await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
    },

    async post(h: Handle, text: string): Promise<void> {
      const peer = findLivePeer(sessionsDir(), h.sessionId)
      if (!peer) throw new Error(`找不到会话 ${h.sessionId} 的活管道（会话可能已结束）：${sessionsDir()}`)
      const r = await deliverToPeer(peer, text, {
        closeDelayMs: cfg.postCloseDelayMs,
        timeoutMs: cfg.postTimeoutMs,
      })
      if (!r.ok) throw new Error(`投递到 ${h.sessionId} 失败：${r.why}`)
      log('info', `已投递到会话 ${h.sessionId}`)
    },
  }
}
