/** 飞书 IM 事件源：`lark-cli event consume im.message.receive_v1 --as bot`，一行一事件。 */

import { z } from 'zod'
import type { PluginContext, Source } from '../../domain/ports.ts'
import type { Event } from '../../domain/types.ts'
import { eventId } from '../../domain/ids.ts'
import { mapMessage } from '../../plugin-kit/map.ts'
import { spawnLines, type LineProcess } from '../../plugin-kit/spawn.ts'
import { explainExit, restartDelay } from '../../plugin-kit/restart.ts'
import {
  fetchFeishuHistory,
  type FeishuHistoryConfig,
} from '../../plugin-kit/feishu-history.ts'

/**
 * 实测字段（生产日志 150 条）：扁平的 16 个顶层键，没有 `mentions`，
 * 发送者只有 `sender_id`，`create_time` 是 13 位毫秒字符串。
 */
const FieldsSchema = z.object({
  externalId: z.string().default('message_id'),
  text: z.string().default('content'),
  channelId: z.string().default('chat_id'),
  channelType: z.string().default('chat_type'),
  actorId: z.string().default('sender_id'),
  occurredAt: z.string().default('create_time'),
  actorName: z.string().optional(),
  channelName: z.string().optional(),
  threadId: z.string().optional(),
  rootId: z.string().optional(),
  replyTo: z.string().optional(),
  atMe: z.string().optional(),
})

export const manifest = {
  id: 'source-feishu-im',
  kind: 'source' as const,
  config: z.object({
    binary: z.string().default('lark-cli'),
    args: z.array(z.string()).default(['event', 'consume', 'im.message.receive_v1', '--as', 'bot']),
    // 话题群里每条消息都带 thread_id，新话题与话题内回复靠 root_id 区分
    fields: FieldsSchema.default({ threadId: 'thread_id', rootId: 'root_id', replyTo: 'reply_to' }),
    /** chat_type: group 为群聊，p2p 为私聊 */
    groupValues: z.array(z.string()).default(['group']),
    history: z
      .object({
        enabled: z.boolean().default(true),
        binary: z.string().default('lark-cli'),
        args: z
          .array(z.string())
          .default([
            'im',
            '+chat-messages-list',
            '--chat-id',
            '{{chatId}}',
            '--as',
            '{{identity}}',
            '--format',
            'json',
            '--page-size',
            '{{limit}}',
            '--order',
            'desc',
          ]),
        timeoutMs: z.number().int().positive().default(20_000),
        identity: z.enum(['user', 'bot']).default('user'),
      })
      .default({}),
  }),
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  const cfg = ctx.config
  let proc: LineProcess | null = null
  let restartTimer: NodeJS.Timeout | null = null
  let stopping = false
  let attempt = 0

  const source: Source = {
    async start(emit) {
      // 注意：spawnLines 保持 stdin 打开；lark-cli 见 stdin EOF 会立刻退出。
      const boot = (): void => {
      proc = spawnLines({
        binary: cfg.binary,
        args: cfg.args,
        log: ctx.log,
        onStderr: (line) => ctx.log('debug', `stderr: ${line}`),
        onExit: (rawCode) => {
          const code = rawCode ?? -1
          if (stopping) return
          ctx.log(code === 0 ? 'info' : 'warn', explainExit(code, '消息消费'))
          attempt++
          restartTimer = setTimeout(boot, restartDelay(code, attempt))
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
          const mapped = mapMessage(payload, {
            source: manifest.id,
            fields: cfg.fields,
            groupValues: cfg.groupValues,
          })
          if (!mapped.ok) {
            ctx.log(
              'warn',
              `事件缺字段，跳过：${mapped.missing.join(', ')}；payload 顶层键：${mapped.keys.join(', ')}`,
            )
            return
          }
          const e: Event = { ...mapped.event, id: eventId(manifest.id, mapped.event.externalId) }
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
    fetchHistory: cfg.history.enabled
      ? (q) => fetchFeishuHistory(cfg.history as FeishuHistoryConfig, q)
      : undefined,
  }

  ctx.register(source)
}
