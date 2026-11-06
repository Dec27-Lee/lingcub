/**
 * 文档写回的纯逻辑（P4c-d）：先比对版本/指纹，再只替换自己的小节。
 * 冲突不自动合并，返回 blocked 让调用方交给人；不碰平台。
 */

import { createHash } from 'node:crypto'

export interface DocSnapshot {
  /** 平台给的版本号；没有就传空串 */
  revision: string
  markdown: string
}

export type WriteDecision =
  | { ok: true; markdown: string }
  | { ok: false; reason: 'revision' | 'fingerprint' | 'missing-section'; actualRevision: string }

export function fingerprint(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex')
}

/** 取 `## 标题` 小节的正文（不含标题行与下一个 `## `）。 */
export function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`.trim())
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n').replace(/^\n+|\n+$/g, '')
}

/**
 * 计划一次小节写回：版本或指纹不一致 → 冲突；小节不存在 → 缺节。
 * 成功时只替换该小节正文，其余字节保持不变。
 */
export function planSectionWrite(
  current: DocSnapshot,
  heading: string,
  body: string,
  expect: { revision: string; fingerprint: string },
): WriteDecision {
  if (current.revision !== expect.revision) {
    return { ok: false, reason: 'revision', actualRevision: current.revision }
  }
  if (fingerprint(current.markdown) !== expect.fingerprint) {
    return { ok: false, reason: 'fingerprint', actualRevision: current.revision }
  }
  const lines = current.markdown.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`.trim())
  if (start < 0) return { ok: false, reason: 'missing-section', actualRevision: current.revision }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i
      break
    }
  }
  let contentEnd = end
  while (contentEnd > start + 1 && lines[contentEnd - 1] === '') contentEnd--
  const next = [...lines.slice(0, start + 1), ...body.split('\n'), ...lines.slice(contentEnd)]
  return { ok: true, markdown: next.join('\n') }
}
