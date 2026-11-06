/**
 * 图片消息的正文处理（参考项目 session.js 里的三个函数）。
 *
 * 飞书给图的两种形态：
 *   · 纯图片消息：content 是 `{"image_key":"img_xxx"}` 这样的 JSON；
 *   · 带文字的图文消息：content 已经是 markdown，图是 `![Image](img_v3_xxx)`（老版本还给过 `[Image: img_xxx]`）。
 * 两种都得认——只认一种，另一种的图会被静默当成普通文字投给窗口，用户以为发了图，窗口只看到一串 img_ 字面量。
 *
 * 下载完把标记原地换成 `[图片] <绝对路径>`（窗口里的 Claude 用 Read 就能读），
 * 失败就换成 `[图片下载失败: img_xxx]`，不静默丢。
 */

import { normalizeImageContent } from '../domain/images.ts'

/** 历史入口：纯函数已移到 domain，内核调用方无需改 import。 */
export { extractImageKeys, normalizeImageContent } from '../domain/images.ts'

/**
 * 把正文里的图片标记换成本地路径。
 * @param resolved key → 本地绝对路径；map 里没有或值为 undefined 视为下载失败
 */
export function replaceImageMarks(content: string, resolved: Map<string, string | undefined>): string {
  let text = normalizeImageContent(content)
  for (const [key, abs] of resolved) {
    const mark = abs ? `[图片] ${abs}` : `[图片下载失败: ${key}]`
    // 同一张图可能在正文里出现多次，一起换掉
    text = text
      .split(`![Image](${key})`)
      .join(mark)
      .split(`[Image: ${key}]`)
      .join(mark)
    // 还有别的 alt 文本写法：`![任意](img_x)`
    text = text.replace(new RegExp(`!\\[[^\\]]*\\]\\(${key}\\)`, 'g'), mark)
  }
  return text
}

/**
 * 图片落盘目录：按**本地**日期分（`YYYYMMDD`）。
 * 不能用 toISOString()——那是 UTC，北京时间早上 8 点前的图会落到前一天。
 */
export function imageDayDir(base: string, at: Date = new Date()): string {
  const day = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`
  return `${base}/${day}`
}
