/**
 * 飞书卡片回调事件源（v2）：把 `card.action.trigger` 归一成领域事件 `card.action`。
 * 与 v1 `source-feishu-card` 的区别：不把原始载荷塞进 message 事件，而是发类型化事件；
 * 默认不启动，避免和 v1 同时消费同一事件流。
 */

import { z } from 'zod'
import { parseCardAction, type CardAction } from '../../domain/card-action.ts'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Source } from '../../domain/ports.ts'
import { spawnLines, type LineProcess } from '../../plugin-kit/spawn.ts'
import { explainExit, restartDelay } from '../../plugin-kit/restart.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'source-feishu-card-v2',
  roles: ['source'],
  config: z
    .object({
      binary: z.string().default('lark-cli'),
      args: z.array(z.string()).default(['event', 'consume', 'card.action.trigger', '--as', 'bot']),
    })
    .strict(),
}

type Emit = (kind: string, payload: unknown, opts: { id: string; subject?: string }) => void

/** 纯函数入口：测试直接调它，不走子进程。 */
export function handlePayload(payload: unknown, emit: Emit): CardAction | null {
  const a = parseCardAction(payload)
  if (!a) return null
  emit('card.action', a, { id: `card:${a.id}`, subject: a.chatId })
  return a
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as { binary: string; args: string[] }
  let proc: LineProcess | null = null
  let restartTimer: NodeJS.Timeout | null = null
  let stopping = false
  let attempt = 0

  const source: Source = {
    async start() {
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
            if (!handlePayload(payload, (kind, p, opts) => ctx.emit(kind, p, opts))) {
              ctx.log('warn', '卡片回调缺字段，跳过')
            }
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

  ctx.registerPort(source)
}
