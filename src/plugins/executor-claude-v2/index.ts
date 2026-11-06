/**
 * claude 执行器 v2（P2.6）：
 *   - 仍然注册 Executor 端口，供旧的 task.open/dispatch 路径过渡；
 *   - 消费 session.open.requested：headless 走 `claude --bg`，terminal 走本机窗口；
 *   - 成功发 session.opened，失败发 session.open.failed。
 *
 * 终端窗口的 SessionStart 注册等待放在 terminal.ts，不把平台细节塞进内核。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { SessionOpenRequest } from '../../domain/types.ts'
import { claudeConfigSchema, createClaudeExecutor, type ClaudeConfig } from '../../plugin-kit/claude-executor.ts'
import { openGate } from '../../plugin-kit/open-gate.ts'
import { openClaudeTerminal } from './terminal.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'executor-claude-v2',
  roles: ['executor'],
  on: ['session.open.requested'],
  config: claudeConfigSchema.extend({
    /** terminal 模式等 SessionStart 注册的上限；超时按失败处理，不假装开窗成功 */
    openTimeoutMs: z.number().int().positive().default(30_000),
    /** terminal 模式允许的最大等待；headless 不用 */
    terminal: z.boolean().default(true),
  }),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as ClaudeConfig & { openTimeoutMs: number; terminal: boolean }
  ctx.registerPort(createClaudeExecutor(cfg, ctx.log))

  const inflight = new Set<string>()
  const recentByWorkspace = new Map<string, number>()

  /** 真正的开窗流程。最长要等 30 秒注册，只能放后台跑。 */
  const open = async (req: SessionOpenRequest): Promise<void> => {
    const sessionsDir = cfg.sessionsDir || join(homedir(), '.claude', 'sessions')
    const sessionId = randomUUID()
    try {
      if (req.mode === 'terminal' && cfg.terminal) {
        await openClaudeTerminal({
          sessionId,
          cwd: req.work.workspace,
          resumeSessionId: req.work.resumeSessionId,
          sessionsDir,
          timeoutMs: cfg.openTimeoutMs,
          log: ctx.log,
        })
      } else {
        // headless 模式复用端口实现，拿到 claude 自己生成的会话 id
        const exec = createClaudeExecutor(cfg, ctx.log)
        const handle = await exec.start(req.work)
        ctx.emit(
          'session.opened',
          {
            requestId: req.requestId,
            executor: 'claude',
            sessionId: handle.sessionId,
            cwd: handle.workspace,
          },
          { id: `opened:${req.requestId}`, subject: req.requestId },
        )
        return
      }
      ctx.emit(
        'session.opened',
        {
          requestId: req.requestId,
          executor: 'claude',
          sessionId,
          cwd: req.work.workspace,
        },
        { id: `opened:${req.requestId}`, subject: req.requestId },
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.log('warn', `开窗失败：${req.requestId} — ${reason}`)
      ctx.emit(
        'session.open.failed',
        { requestId: req.requestId, reason },
        { id: `open-failed:${req.requestId}`, subject: req.requestId },
      )
    }
  }

  ctx.on('session.open.requested', async (e) => {
    const req = e.payload as SessionOpenRequest
    if (req.work.executor !== 'claude') return
    if (inflight.has(req.requestId)) return
    // 连点两下 / 事件重投：同工作区 60 秒内只开一个窗口，别再弹第二个终端
    const wsKey = `${req.mode}|${req.work.workspace}`
    if (!openGate(recentByWorkspace, wsKey, Date.now())) {
      ctx.log('warn', `开窗请求 ${req.requestId} 与上一个同工作区请求间隔不足 60 秒，忽略（避免连点开多窗）`)
      // 必须在界面上说一声：否则用户点了没反应，只会反复点
      ctx.emit(
        'session.open.failed',
        {
          requestId: req.requestId,
          reason: `同一工作区 60 秒内已经开过一次窗口（${req.work.workspace}），为免开出多个终端先忽略这次；稍等一会儿或换工作区再试`,
        },
        { id: `open-gated:${req.requestId}`, subject: req.requestId },
      )
      return
    }
    inflight.add(req.requestId)
    // 关键：订阅里不许等 30 秒（事件总线单个 handler 5 秒超时，超时会重投 → 一次点击开出五个窗口）
    void open(req).finally(() => inflight.delete(req.requestId))
  })
}
