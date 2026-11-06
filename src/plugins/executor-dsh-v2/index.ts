/** dsh 执行器 v2：消费 session.open.requested；dsh 没有终端窗口预设 id，只支持 headless。 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { SessionOpenRequest } from '../../domain/types.ts'
import { createDshExecutor, dshConfigSchema, type DshConfig } from '../../plugin-kit/dsh-executor.ts'
import { openGate } from '../../plugin-kit/open-gate.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'executor-dsh-v2',
  roles: ['executor'],
  on: ['session.open.requested'],
  config: dshConfigSchema.extend({
    terminal: z.literal(false).default(false),
  }),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as DshConfig
  ctx.registerPort(createDshExecutor(cfg, ctx.log))

  const inflight = new Set<string>()
  const recentByWorkspace = new Map<string, number>()

  const open = async (req: SessionOpenRequest): Promise<void> => {
    try {
      const exec = createDshExecutor(cfg, ctx.log)
      const handle = await exec.start(req.work)
      ctx.emit(
        'session.opened',
        {
          requestId: req.requestId,
          executor: 'dsh',
          sessionId: handle.sessionId,
          cwd: handle.workspace,
        },
        { id: `opened:${req.requestId}`, subject: req.requestId },
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.emit(
        'session.open.failed',
        { requestId: req.requestId, reason },
        { id: `open-failed:${req.requestId}`, subject: req.requestId },
      )
    }
  }

  ctx.on('session.open.requested', async (e) => {
    const req = e.payload as SessionOpenRequest
    if (req.work.executor !== 'dsh') return
    if (req.mode === 'terminal') {
      ctx.emit(
        'session.open.failed',
        { requestId: req.requestId, reason: 'dsh 暂不支持 terminal 模式（没有预设 session id 入口）' },
        { id: `open-failed:${req.requestId}`, subject: req.requestId },
      )
      return
    }
    if (inflight.has(req.requestId)) return
    // 与 claude 侧同一条闸门：dsh 起任务也要好几秒，事件重投会真的起第二个任务
    if (!openGate(recentByWorkspace, `${req.mode}|${req.work.workspace}`, Date.now())) {
      ctx.log('warn', `开窗请求 ${req.requestId} 与上一个同工作区请求间隔不足 60 秒，忽略（避免重复起 dsh 任务）`)
      ctx.emit(
        'session.open.failed',
        {
          requestId: req.requestId,
          reason: `同一工作区 60 秒内已经起过一次 dsh 会话（${req.work.workspace}），先忽略这次`,
        },
        { id: `open-gated:${req.requestId}`, subject: req.requestId },
      )
      return
    }
    inflight.add(req.requestId)
    // 订阅里不等 dsh 起完（事件总线 5 秒超时，超时会重投 → 一次点击起两个任务）
    void open(req).finally(() => inflight.delete(req.requestId))
  })
}
