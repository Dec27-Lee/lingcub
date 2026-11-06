/** 钉钉事件源：`dws event +listen-im … -f ndjson` 长连接，一行一事件。 */

import { z } from 'zod'
import type { PluginContext, Source } from '../../domain/ports.ts'
import type { Event } from '../../domain/types.ts'
import { eventId } from '../../domain/ids.ts'
import { mapMessage } from '../../plugin-kit/map.ts'
import { spawnLines, type LineProcess } from '../../plugin-kit/spawn.ts'
import { DingTalkHistoryArgs, fetchDingTalkHistory } from '../../plugin-kit/dingtalk-source.ts'

const FieldsSchema = z.object({
  externalId: z.string(),
  text: z.string(),
  channelId: z.string(),
  channelType: z.string().optional(),
  actorId: z.string(),
  occurredAt: z.string().optional(),
  actorName: z.string().optional(),
  channelName: z.string().optional(),
  threadId: z.string().optional(),
  atMe: z.string().optional(),
})

export const manifest = {
  id: 'source-dingtalk',
  kind: 'source' as const,
  config: z.object({
    binary: z.string().default('dws'),
    args: z.array(z.string()).default([
      'event',
      '+listen-im',
      '--kind',
      'all-direct',
      '-f',
      'ndjson',
    ]),
    /** 扁平化后的字段名（平台事实，未实测时改这里而不是改代码） */
    fields: FieldsSchema,
    /** 这些取值算群聊，其余按私聊 */
    groupValues: z.array(z.string()).default([]),
    /** all-direct 的事件本身已限定私聊；平台不给 channelType 时用它 */
    fallbackChannelKind: z.enum(['dm', 'group']).default('dm'),
    /** 平台事件库之外补拉同会话历史；留空则只用事件库 */
    historyArgs: z.array(z.string()).default([...DingTalkHistoryArgs]),
  }),
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  const cfg = ctx.config
  let proc: LineProcess | null = null

  const source: Source = {
    async start(emit) {
      proc = spawnLines({
        binary: cfg.binary,
        args: cfg.args,
        log: ctx.log,
        onStderr: (line) => ctx.log('debug', `stderr: ${line}`),
        onExit: (code) => ctx.log(code === 0 ? 'info' : 'warn', `事件消费进程退出：code=${code}`),
        onLine: (line) => {
          let payload: unknown
          try {
            payload = JSON.parse(line) as unknown
          } catch {
            ctx.log('debug', '非 JSON 行，跳过')
            return
          }
          // `event consume` 是 transport envelope（业务字段在 data）；`+listen-im` 多数时候直接扁平。
          const body =
            typeof payload === 'object' &&
            payload !== null &&
            'data' in payload &&
            typeof (payload as { data?: unknown }).data === 'object' &&
            (payload as { data?: unknown }).data !== null
              ? (payload as { data: unknown }).data
              : payload
          const mapped = mapMessage(body, {
            source: manifest.id,
            fields: cfg.fields,
            groupValues: cfg.groupValues,
            fallbackChannelKind: cfg.fallbackChannelKind,
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
    },
    async stop() {
      await proc?.stop()
      proc = null
    },
    async fetchHistory(q) {
      if (!cfg.historyArgs.length) return undefined
      const args = cfg.historyArgs.map((a) =>
        a.replaceAll('{{channelId}}', q.channelId).replaceAll('{{limit}}', String(q.limit)),
      )
      return fetchDingTalkHistory({ binary: cfg.binary, args, log: ctx.log }, q)
    },
  }

  ctx.register(source)
}
