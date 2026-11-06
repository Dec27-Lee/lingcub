/** 钉钉 @我来源：群聊里 at 我的消息。 */

import { z } from 'zod'
import type { PluginContext } from '../../domain/ports.ts'
import {
  createDingTalkStream,
  DingTalkFieldsSchema,
  DingTalkHistoryArgs,
} from '../../plugin-kit/dingtalk-source.ts'

const defaultFields = {
  externalId: 'message_id',
  text: 'content',
  channelId: 'conversation_id',
  actorId: 'sender_open_dingtalk_id',
  occurredAt: 'create_time',
  actorName: 'sender',
}

export const manifest = {
  id: 'source-dingtalk-at',
  kind: 'source' as const,
  config: z.object({
    binary: z.string().default('dws'),
    args: z.array(z.string()).default(['event', '+listen-im', '--kind', 'at-me', '-f', 'ndjson']),
    fields: DingTalkFieldsSchema.default(defaultFields),
    groupValues: z.array(z.string()).default([]),
    fallbackChannelKind: z.enum(['dm', 'group']).default('group'),
    resolveGroupTitle: z.boolean().default(true),
    historyArgs: z.array(z.string()).default([...DingTalkHistoryArgs]),
  }),
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  const cfg = ctx.config
  ctx.register(
    createDingTalkStream({
      source: manifest.id,
      binary: cfg.binary,
      args: cfg.args,
      fields: cfg.fields,
      groupValues: cfg.groupValues,
      fallbackChannelKind: cfg.fallbackChannelKind,
      resolveGroupTitle: cfg.resolveGroupTitle,
      historyArgs: cfg.historyArgs,
      log: ctx.log,
    }),
  )
}
