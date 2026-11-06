/** 纯文本处理：图片消息正文归一与 image key 抽取。内核和插件共用。 */

export function normalizeImageContent(content: string): string {
  const s = content.trim()
  if (!s.startsWith('{')) return content
  try {
    const j = JSON.parse(s) as { image_key?: unknown }
    if (typeof j.image_key === 'string' && j.image_key) return `![Image](${j.image_key})`
  } catch {
    /* 不是 JSON 就原样返回 */
  }
  return content
}

const IMAGE_MARK_RE = /!\[[^\]]*\]\((img_[A-Za-z0-9_-]+)\)|\[Image:\s*(img_[A-Za-z0-9_-]+)\]/g

/** 正文里出现的所有图片 key（去重，保持出现顺序）。 */
export function extractImageKeys(content: string): string[] {
  const normalized = normalizeImageContent(content)
  const found: string[] = []
  for (const m of normalized.matchAll(IMAGE_MARK_RE)) {
    const key = m[1] ?? m[2]
    if (key && !found.includes(key)) found.push(key)
  }
  return found
}
