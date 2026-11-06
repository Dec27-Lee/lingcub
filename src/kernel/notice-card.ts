/**
 * 结果通知卡（参考项目 notify 的 buildCard）。
 *
 * 为什么是卡片而不是一段文字：卡片标题栏能取窗口名（飞书据此生成话题名），
 * 颜色能表达状态（绿=正常结束），而且 📁 / 🕐 / 📦 必须**各占一个 markdown 元素**——
 * 飞书会把同一个元素里的单换行折成一个段落，挤在一起就分不出行了。
 */

/** 「你在终端里说」短内容直接摆，长内容折叠（手机屏幕上不占地方）。 */
export const SAID_INLINE_MAX = 180
/** 折叠区也不是无上限：卡片整体 30KB，正文还要放 AI 的回复。 */
export const SAID_FULL_MAX = 3000

export interface NoticeCardData {
  /** 窗口名：首条卡片用它做标题（飞书据此生成话题名） */
  title: string
  cwd?: string
  time: string
  stats?: string
  /** 用户在终端里敲的那句话 */
  userSaid?: string
  body: string
  /** 分段：第几段 / 共几段（只有多段时才有意义） */
  index?: number
  total?: number
}

export interface NoticeElement {
  tag: string
  content?: string
  [k: string]: unknown
}

/** 每行前面加 │：手机上没有 blockquote 样式，靠这个做出引用块观感。 */
export function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((l) => `<font color='grey'>│ ${l}</font>`)
    .join('\n')
}

/** 「你在终端里说」那一段：短的就摆出来，长的折起来（截断也要说清原文多少字）。 */
export function buildUserSaid(text: string | undefined): NoticeElement[] {
  if (!text) return []
  const clipped = text.length > SAID_FULL_MAX
  const shown = clipped ? `${text.slice(0, SAID_FULL_MAX)}\n…（原文共 ${text.length} 字，此处截断）` : text
  const oneLine = text.replace(/\s+/g, ' ').trim()
  const compactEnough = text.length <= SAID_INLINE_MAX && !text.includes('\n')
  if (compactEnough) {
    return [
      { tag: 'hr' },
      { tag: 'markdown', content: '💬 **你在终端里说**' },
      { tag: 'markdown', content: quoteLines(shown) },
    ]
  }
  const head = (text.split('\n')[0] || oneLine).slice(0, 40)
  const hint = text.length > SAID_INLINE_MAX ? `（共 ${text.length} 字）` : ''
  return [
    { tag: 'hr' },
    {
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: `💬 你在终端里说：${head}…${hint}` },
        width: 'fill',
        icon_position: 'right',
        icon_expanded_angle: 180,
      },
      vertical_spacing: '4px',
      elements: [{ tag: 'markdown', content: quoteLines(shown) }],
    },
  ]
}

/** 卡片数据（渲染成飞书卡片由频道插件负责）。 */
export function buildNoticeCard(a: NoticeCardData): unknown {
  const continued = (a.index ?? 1) > 1
  return {
    kind: 'notice',
    title: continued && (a.total ?? 1) > 1 ? `${a.title} (${a.index}/${a.total})` : a.title,
    status: 'done',
    cwd: a.cwd,
    time: a.time,
    stats: a.stats,
    userSaid: a.userSaid,
    body: a.body,
    continued,
  }
}
