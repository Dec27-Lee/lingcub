/**
 * 飞书「卡片按钮回调」事件源（`card.action.trigger`）。
 *
 * 参考项目同样是**单独订阅**这个事件（`im.message.receive_v1` 收不到按钮点击）。
 * 真实载荷（取自参考项目日志）：
 *   {"type":"card.action.trigger","event_id":"…","timestamp":"…","operator_id":"ou_…",
 *    "message_id":"om_…","chat_id":"oc_…","host":"im_message","token":"…",
 *    "action_tag":"button","action_value":"{\"k\":\"pick\",…}","checked":false}
 * 注意：**没有 thread_id**，所以话题信息由按钮 value 自己带。
 */

import { z } from 'zod'
import { parseCardAction } from '../../domain/card-action.ts'
import type { Event } from '../../domain/types.ts'
import type { PluginContext, Source } from '../../domain/ports.ts'
import { spawnLines, type LineProcess } from '../../plugin-kit/spawn.ts'
import { explainExit, restartDelay } from '../../plugin-kit/restart.ts'

export const manifest = {
  id: 'source-feishu-card',
  kind: 'source' as const,
  config: z.object({
    binary: z.string().default('lark-cli'),
    args: z.array(z.string()).default(['event', 'consume', 'card.action.trigger', '--as', 'bot']),
  }),
}

const nowIso = (): string => new Date().toISOString()

/** 把一条回调载荷映射成内核事件；字段缺失就返回 null（不猜）。 */
export function mapCardAction(payload: unknown, fallbackAt: string): Event | null {
  const a = parseCardAction(payload)
  if (!a) return null
  return {
    id: a.id,
    source: manifest.id,
    externalId: a.id,
    receivedAt: fallbackAt,
    occurredAt: fallbackAt,
    actor: { id: a.actorId ?? '' },
    channel: { kind: 'group', id: a.chatId },
    text: a.rawAction,
    raw: payload,
  }
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  const cfg = ctx.config
  let proc: LineProcess | null = null
  let restartTimer: NodeJS.Timeout | null = null
  let stopping = false
  let attempt = 0

  const source: Source = {
    async start(emit) {
      const boot = (): void => {
        proc = spawnLines({
        binary: cfg.binary,
        args: cfg.args,
        log: ctx.log,
        onStderr: (line) => ctx.log('debug', `stderr: ${line}`),
        onExit: (rawCode) => {
          const code = rawCode ?? -1
          if (stopping) return
          ctx.log(code === 0 ? 'info' : 'warn', explainExit(code, '卡片回调'))
          // 退出就重试：没有这条，按钮点不动时进程死了也不会自己回来
          attempt++
          const wait = restartDelay(code, attempt)
          restartTimer = setTimeout(boot, wait)
          restartTimer.unref?.()
        },
        onLine: (line) => {
          let payload: unknown
          try {
            payload = JSON.parse(line) as unknown
          } catch {
            ctx.log('debug', '非 JSON 行，跳过')
            return
          }
          const e = mapCardAction(payload, nowIso())
          if (!e) {
            ctx.log('warn', '卡片回调缺字段，跳过')
            return
          }
          emit(e)
        },
        })
      }
      boot()
    },
    async stop() {
      stopping = true
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = null
      await proc?.stop()
      proc = null
    },
  }

  ctx.register(source)
}
