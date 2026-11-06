/**
 * 媒体归一能力：把消息里的平台媒体引用解析成可分发图片（下载/上传/清理都在能力内部）。
 * 分发消费者只拿 {images, text}，不再直接调 dws/lark-cli，也不读平台 mediaId 细节。
 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event } from '../../domain/types.ts'
import { resolveDingTalkImageLinks, renderImageText } from '../../plugin-kit/dingtalk-media.ts'

const EventInput = z.object({
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  text: z.string(),
  channel: z.object({ kind: z.string(), id: z.string(), name: z.string().optional() }),
})

export const manifest: ManifestV2 = {
  v: 2,
  id: 'capability-media',
  roles: ['capability'],
  provides: [{ name: 'media.resolve', effect: 'none' }],
  config: z.object({}).strict(),
}

export function setup(ctx: PluginContextV2): void {
  ctx.provide(
    'media.resolve',
    {
      input: z.object({ event: EventInput }),
      output: z.object({
        text: z.string(),
        images: z.array(
          z.object({
            mediaId: z.string(),
            url: z.string().optional(),
            path: z.string().optional(),
            imageKey: z.string().optional(),
          }),
        ),
      }),
    },
    async (input) => {
      const event = input.event as Event
      const images = await resolveDingTalkImageLinks(event)
      return { text: renderImageText(event.text, images), images }
    },
  )
}
