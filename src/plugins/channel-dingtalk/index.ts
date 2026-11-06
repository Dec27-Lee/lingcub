/**
 * 钉钉渠道插件（v2）：两个独立 consume（单聊/群）+ 本人身份模板回执。
 * 平台事实见 docs/006：用户类/群类不能共用一个 consume；出站只能 `--as user`，幂等键仅 user 支持。
 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Channel } from '../../domain/ports.ts'
import type { Event } from '../../domain/types.ts'
import { eventId } from '../../domain/ids.ts'
import { extractJson } from '../../plugin-kit/json.ts'
import { mapMessage } from '../../plugin-kit/map.ts'
import { runOnce, spawnLines, type LineProcess } from '../../plugin-kit/spawn.ts'
import { renderArgs } from '../../plugin-kit/template.ts'

const FieldsSchema = z.object({
  externalId: z.string(),
  text: z.string(),
  channelId: z.string(),
  channelType: z.string(),
  actorId: z.string(),
  occurredAt: z.string().optional(),
  actorName: z.string().optional(),
  channelName: z.string().optional(),
  threadId: z.string().optional(),
  rootId: z.string().optional(),
  replyTo: z.string().optional(),
  atMe: z.string().optional(),
})

type Config = {
  binary: string
  o2oArgs: string[]
  groupArgs: string[]
  replyArgs: string[]
  fields: z.infer<typeof FieldsSchema>
  o2oGroupValues: string[]
  groupGroupValues: string[]
  enabledO2o: boolean
  enabledGroup: boolean
  timeoutMs: number
}

export const manifest: ManifestV2 = {
  v: 2,
  id: 'channel-dingtalk',
  roles: ['channel'],
  provides: [
    {
      name: 'transport.dingtalk.send',
      effect: 'message',
      input: z.object({
        target: z.object({
          openDingtalkId: z.string().min(1),
          messageId: z.string().min(1),
          conversationId: z.string().optional(),
        }),
        text: z.string().min(1),
      }),
    },
  ],
  config: z
    .object({
      binary: z.string().default('dws'),
      o2oArgs: z.array(z.string()).default([
        'event',
        'consume',
        'user_im_message_receive_o2o_all',
        '--flatten',
        '-f',
        'ndjson',
      ]),
      groupArgs: z.array(z.string()).default([
        'event',
        'consume',
        'user_im_message_receive_group_all',
        '--flatten',
        '-f',
        'ndjson',
      ]),
      replyArgs: z.array(z.string()).default([
        'chat',
        '+messages-reply',
        '--as',
        'user',
        '--open-dingtalk-id',
        '{{openDingtalkId}}',
        '--ref-msg-id',
        '{{messageId}}',
        '--content',
        '{{text}}',
        '--idempotency-key',
        '{{dedupeKey}}',
        '-f',
        'json',
      ]),
      fields: FieldsSchema.default({
        externalId: 'message_id',
        text: 'content',
        channelId: 'conversation_id',
        channelType: 'type',
        actorId: 'sender_open_dingtalk_id',
        occurredAt: 'create_time',
        actorName: 'sender',
        threadId: 'conversation_id',
        rootId: 'message_id',
        replyTo: 'quoted_message.message_id',
      }),
      /** 各 consume 的 type 取值；群里那个把事件键当群标记，单聊留空 */
      o2oGroupValues: z.array(z.string()).default([]),
      groupGroupValues: z.array(z.string()).default(['user_im_message_receive_group_all']),
      enabledO2o: z.boolean().default(true),
      enabledGroup: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(60_000),
    })
    .strict(),
}

const procsByCtx = new WeakMap<object, LineProcess[]>()

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as Config
  const channel: Channel = {
    async send() {
      throw new Error('channel-dingtalk 只支持 transport.dingtalk.send（回执），不支持通用 send')
    },
    async sendTransport(input, dedupeKey) {
      const args = renderArgs(cfg.replyArgs, {
        openDingtalkId: input.target.openDingtalkId ?? '',
        messageId: input.target.messageId ?? '',
        text: input.text,
        dedupeKey,
      })
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) {
        throw new Error(`钉钉回执失败（code=${r.code}）：${r.stderr.trim() || r.stdout.trim()}`)
      }
      const parsed = extractJson(r.stdout) as
        | {
            ok?: boolean
            error?: { message?: string }
            messageId?: string
            message_id?: string
            data?: { messageId?: string; message_id?: string }
          }
        | null
      if (parsed?.ok === false || parsed?.error) {
        throw new Error(`钉钉回执失败：${parsed.error?.message ?? r.stdout.trim()}`)
      }
      return {
        messageId:
          parsed?.data?.messageId ??
          parsed?.data?.message_id ??
          parsed?.messageId ??
          parsed?.message_id,
      }
    },
  }
  ctx.registerPort(channel)
}

export async function start(ctx: PluginContextV2): Promise<void> {
  const cfg = ctx.config as Config
  const procs: LineProcess[] = []
  const add = (args: string[], groupValues: string[], label: string): void => {
    procs.push(
      spawnLines({
        binary: cfg.binary,
        args,
        log: ctx.log,
        onLine: (line) => ingestLine(ctx, cfg, line, groupValues),
        onStderr: (line) => ctx.log('debug', `钉钉 ${label} stderr: ${line}`),
        onExit: (code) => ctx.log(code === 0 ? 'info' : 'warn', `钉钉 ${label} consume 退出：code=${code}`),
      }),
    )
  }
  if (cfg.enabledO2o) add(cfg.o2oArgs, cfg.o2oGroupValues, 'o2o')
  if (cfg.enabledGroup) add(cfg.groupArgs, cfg.groupGroupValues, 'group')
  procsByCtx.set(ctx, procs)
}

export async function stop(ctx: PluginContextV2): Promise<void> {
  const procs = procsByCtx.get(ctx) ?? []
  procsByCtx.delete(ctx)
  await Promise.all(procs.map((p) => p.stop()))
}

function ingestLine(
  ctx: PluginContextV2,
  cfg: { fields: z.infer<typeof FieldsSchema> },
  line: string,
  groupValues: string[],
): void {
  let payload: unknown
  try {
    payload = JSON.parse(line) as unknown
  } catch {
    ctx.log('debug', '钉钉：非 JSON 行，跳过')
    return
  }
  const mapped = mapMessage(payload, { source: 'dingtalk', fields: cfg.fields, groupValues })
  if (!mapped.ok) {
    ctx.log('warn', `钉钉事件缺字段，跳过：${mapped.missing.join(', ')}；顶层键：${mapped.keys.join(', ')}`)
    return
  }
  const event: Event = { ...mapped.event, id: eventId('dingtalk', mapped.event.externalId) }
  const r = ctx.ingest(event)
  ctx.log('debug', `钉钉消息 ${event.id} seq=${r.seq}${r.duplicate ? '（重复）' : ''}`)
}
