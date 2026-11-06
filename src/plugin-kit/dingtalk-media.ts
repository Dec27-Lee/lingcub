/** 钉钉图片消息：解析 mediaId、下载并取临时 URL；卡片先用可点击图片链接兜底。 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Event } from '../domain/types.ts'
import { stripDwsMediaNotice } from './dingtalk-text.ts'
import { runOnce } from './spawn.ts'

const IMAGE_RE = /\[图片消息\]\(mediaId=([^)]+)\)/g

export interface ImageLink {
  mediaId: string
  url?: string
  path?: string
  imageKey?: string
}

export function extractImageMediaIds(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(IMAGE_RE)) {
    if (m[1]) out.push(m[1])
  }
  return out
}

export async function resolveDingTalkImageLinks(event: Event, root = '.'): Promise<ImageLink[]> {
  const ids = extractImageMediaIds(event.text)
  if (!ids.length) return []
  const dir = join(root, 'data', 'relay-media', event.id)
  mkdirSync(dir, { recursive: true })
  const out: ImageLink[] = []
  try {
    for (const [i, mediaId] of ids.entries()) {
      const r = await runOnce({
        binary: 'dws',
        args: [
          'chat',
          'message',
          'download-media',
          '--type',
          'mediaId',
          '--resource-id',
          mediaId,
          '--message-id',
          event.externalId,
          '--open-conversation-id',
          event.channel.id,
          '--output',
          join(dir, `${i}.bin`),
          '-f',
          'json',
        ],
        timeoutMs: 30_000,
      })
      if (r.code !== 0) {
        out.push({ mediaId })
        continue
      }
      const path = join(dir, `${i}.bin`)
      try {
        const parsed = JSON.parse(r.stdout) as { downloadUrl?: string }
        out.push({ mediaId, url: parsed.downloadUrl, path })
      } catch {
        out.push({ mediaId, path })
      }
    }
    for (const link of out) {
      if (!link.path || !existsSync(link.path)) continue
      try {
        link.imageKey = await uploadFeishuImage(link.path)
      } catch {
        // 上传失败保留临时下载链接，卡片仍能发；本地副本在 finally 清掉。
        link.imageKey = undefined
      }
    }
  } finally {
    // 只做中转：上传后立刻清掉本地副本，避免按消息量累积占盘。
    rmSync(dir, { recursive: true, force: true })
  }
  return out
}

/** 用当前飞书 bot 上传图片，拿到可放进卡片的 img_key。 */
export async function uploadFeishuImage(path: string): Promise<string | undefined> {
  const r = await runOnce({
    binary: 'lark-cli',
    args: [
      'im',
      'images',
      'create',
      '--as',
      'bot',
      '--data',
      '-',
      '--file',
      `image=${path}`,
      '--format',
      'json',
    ],
    input: '{"image_type":"message"}',
    timeoutMs: 30_000,
  })
  if (r.code !== 0) return undefined
  try {
    const parsed = JSON.parse(r.stdout) as { data?: { image_key?: string }; image_key?: string }
    return parsed.data?.image_key ?? parsed.image_key
  } catch {
    return undefined
  }
}

export function renderImageMarkdown(text: string, links: ImageLink[]): string {
  let i = 0
  return stripDwsMediaNotice(text).replace(IMAGE_RE, () => {
    const link = links[i++]
    if (!link?.url) return '📷 图片（暂不能预览）'
    return `[📷 图片](${link.url})`
  })
}

/** 卡片用：有 img_key 的图片从正文移除，交给卡片 img 元素；没有 key 的退成链接。 */
export function renderImageText(text: string, links: ImageLink[]): string {
  let i = 0
  return stripDwsMediaNotice(text)
    .replace(IMAGE_RE, () => {
      const link = links[i++]
      if (link?.imageKey) return ''
      if (link?.url) return `[📷 图片](${link.url})`
      return '📷 图片（暂不能预览）'
    })
    .trim()
}
