/**
 * 钉钉出站消息来源：个人订阅不会回推自己发出的消息，只能轮询历史并筛 senderId=self。
 * 轮询窗口有重叠，Event id 用 messageId 去重。
 */

import { z } from 'zod'
import type { PluginContext } from '../../domain/ports.ts'
import {
  createDingTalkSent,
  DingTalkFieldsSchema,
  DingTalkHistoryArgs,
} from '../../plugin-kit/dingtalk-source.ts'

const defaultFields = {
  externalId: 'messageId',
  text: 'text',
  channelId: 'openConversationId',
  actorId: 'senderId',
  occurredAt: 'createTime',
  actorName: 'sender',
  channelName: 'conversationTitle',
}

export const manifest = {
  id: 'source-dingtalk-sent',
  kind: 'source' as const,
  config: z.object({
    binary: z.string().default('dws'),
    args: z.array(z.string()).default([
      'chat',
      'message',
      'list-all',
      '--start',
      '{{start}}',
      '--end',
      '{{end}}',
      '--page-all',
      '--no-reactions',
      '-f',
      'json',
    ]),
    /** 自己的 openDingTalkId；从历史或通讯录拿到后写这里 */
    selfId: z.string().default(''),
    fields: DingTalkFieldsSchema.default(defaultFields),
    intervalMs: z.number().int().positive().default(15_000),
    lookbackMinutes: z.number().int().positive().default(10),
    historyArgs: z.array(z.string()).default([...DingTalkHistoryArgs]),
  }),
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  const cfg = ctx.config
  ctx.register(
    createDingTalkSent({
      source: manifest.id,
      binary: cfg.binary,
      args: cfg.args,
      selfId: cfg.selfId,
      fields: cfg.fields,
      intervalMs: cfg.intervalMs,
    lookbackMinutes: cfg.lookbackMinutes,
    historyArgs: cfg.historyArgs,
    log: ctx.log,
    }),
  )
}
