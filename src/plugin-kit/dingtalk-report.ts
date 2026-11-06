/**
 * 钉钉工作日志的展示清理。
 *
 * 钉钉把日报正文和三条客户端深链/Markdown 链接拼在同一个 content 里；飞书卡直接渲染时
 * 会把链接原样铺开。这里只处理展示副本，Event.text 保持不变。
 */

const LINK_LINE = /^\[[^\]]*\]\([^)]*\)\s*$/
const BARE_URL = /^https?:\/\/\S+\s*$/

export function isDingTalkReport(text: string): boolean {
  return /工作日志|工作日报/.test(text) && /今日工作：|日期：/.test(text)
}

export function formatDingTalkReport(text: string): string {
  const logLink = text.match(/^\[日志\]:\s*(.+?的工作日志)\s+url:\s+\S+/s)
  if (logLink) return logLink[1]!.trim()
  if (!isDingTalkReport(text)) return text
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const cut = lines.findIndex((line) => {
    const t = line.trim()
    return LINK_LINE.test(t) || BARE_URL.test(t)
  })
  let body = (cut >= 0 ? lines.slice(0, cut) : lines).map((line) => line.trimEnd())

  // 钉钉日报尾部可能残留「工 / 0 / 0」这类空字段；只清尾部，不动正文中间的行。
  while (body.length) {
    const last = body[body.length - 1]?.trim() ?? ''
    if (last === '' || last === '工' || /^0+$/.test(last)) body.pop()
    else break
  }

  // 「日期：」和日期分行时合到一行，卡片更紧凑。
  const dateAt = body.findIndex((line) => line.trim() === '日期：')
  const next = dateAt >= 0 ? body[dateAt + 1]?.trim() : ''
  if (dateAt >= 0 && next && /^\d{4}-\d{2}-\d{2}$/.test(next)) {
    body[dateAt] = `日期：${next}`
    body.splice(dateAt + 1, 1)
  }

  const out: string[] = []
  for (const line of body) {
    if (!line.trim() && !out[out.length - 1]) continue
    out.push(line.trimEnd())
  }
  return out.join('\n').trim()
}
