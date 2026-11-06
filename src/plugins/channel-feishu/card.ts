/**
 * 状态卡渲染（飞书交互卡片 v1）。
 * 内核只给「状态 + 几行字」，怎么长得由频道决定——换到钉钉时只换这个文件。
 */

import type { CardState } from '../../domain/types.ts'

const COLOR: Record<CardState['status'], string> = {
  running: 'blue',
  done: 'green',
  failed: 'red',
  waiting: 'orange',
}

const LABEL: Record<CardState['status'], string> = {
  running: '进行中',
  done: '已完成',
  failed: '失败了',
  waiting: '等你一下',
}

export function renderCard(state: CardState): unknown {
  const lines = state.lines.length ? state.lines : ['—']
  return {
    config: { wide_screen_mode: true },
    header: {
      template: COLOR[state.status],
      title: { tag: 'plain_text', content: `${state.title} · ${LABEL[state.status]}` },
    },
    // 一行一个元素（参考项目 status 卡）：灰色引文、超长「你说」折成折叠面板，
    // 一整坨 div 里塞所有行时，长文本会把下面的状态全挤走，也没法单独上色。
    elements: lines.map((line) => {
      const longPrompt = line.startsWith('💬 你说：') && (line.length > 120 || line.includes('\n'))
      if (longPrompt) {
        const body = line.slice('💬 你说：'.length)
        return {
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: { tag: 'plain_text', content: `💬 你说：${body.slice(0, 36)}…（${body.length} 字）` },
            width: 'fill',
            icon_position: 'right',
            icon_expanded_angle: 180,
          },
          vertical_spacing: '4px',
          elements: [{ tag: 'markdown', content: body }],
        }
      }
      const grey = line.startsWith('💬 ') || line.startsWith('🤖 ') || line.startsWith('🤔 ')
      return {
        tag: 'markdown',
        content: grey ? `<font color='grey'>${line}</font>` : line,
      }
    }),
  }
}

/** 工作区选择卡的选项：按钮上带 value，点了走卡片回调。 */
export interface PickerOption {
  /** 工作区标识（`project:demo` 或 `root:<绝对路径>`），回调里原样带回内核 */
  key: string
  label: string
}

/**
 * 工作区选择卡（对应参考项目的 buildPickerCard）。
 * 按钮的 value 里带足回调所需的一切：挑哪个工作区、哪个话题、回到哪条消息——
 * 回调事件本身**没有** thread_id，所以必须自己带上。
 */
export function renderPickerCard(a: {
  title: string
  options: readonly PickerOption[]
  threadId?: string
  rootMessageId?: string
  chatId: string
  note?: string
  /** 另起一棵新话题（本话题不动） */
  fresh?: boolean
}): unknown {
  // 卡片最多放 20 个（参考项目 pickMax）；超出时下面会写清「共发现 N 个」
  const shown = a.options.slice(0, 20)
  const hidden = a.options.length - shown.length
  const buttons = shown.map((o, i) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${i + 1}. ${o.label}` },
    type: i === 0 ? 'primary' : 'default',
    value: {
      k: 'pick',
      workspaceId: o.key,
      thread: a.threadId ?? '',
      root: a.rootMessageId ?? '',
      chat: a.chatId,
      fresh: a.fresh ? '1' : '',
    },
  }))

  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: a.fresh ? '**再开一个窗口**' : '**新建窗口**' } },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: a.note ?? '选好工作区后我就把窗口挂在这个话题里，之后直接在这里说话。',
      },
    },
    { tag: 'hr' },
    { tag: 'action', actions: buttons },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        // 回调没订阅上时也别把用户卡死：回序号走文字路径
        content:
          `按钮点不动的话，直接在这个话题里回序号（如 \`1\`）也一样。\n话题名：${a.title}` +
          // 候选比卡片能放的多时说清楚，否则人以为只剩这些
          (hidden > 0 ? `\n共发现 ${a.options.length} 个，卡片最多放 ${shown.length} 个，这里列前 ${shown.length} 个。` : ''),
      },
    },
  ]

  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '选个工作区' } },
    elements,
  }
}


export { renderResumeCard } from '../../plugin-kit/feishu-cards.ts'

/** 选择题卡片：每个选项一个按钮，底部有「我在电脑前，让终端问我」。 */
/** 就绪卡：窗口开好那一刻发，带「换会话 / 再开一个」两个按钮（参考项目 buildReadyCard）。 */
export function renderReadyCard(a: {
  title: string
  cwd?: string
  sessionId: string
  threadId?: string
  rootMessageId?: string
  chatId: string
}): unknown {
  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: `📁 \`${a.cwd ?? ''}\`` },
    { tag: 'markdown', content: `🆔 \`${String(a.sessionId).slice(0, 8)}\`` },
    { tag: 'markdown', content: '现在**直接在这个话题里发消息**即可继续。' },
  ]
  if (a.threadId || a.rootMessageId) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔁 换会话（resume）' },
      type: 'primary',
      value: { k: 'readyresume', thread: a.threadId ?? '', root: a.rootMessageId ?? '', chat: a.chatId },
    })
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '➕ 再开一个窗口' },
      type: 'default',
      value: { k: 'readynewwin', thread: a.threadId ?? '', root: a.rootMessageId ?? '', chat: a.chatId },
    })
    elements.push({
      tag: 'markdown',
      content:
        '换会话：新窗口接续所选会话，**本话题改绑到新窗口**。\n再开一个：另起一棵新话题，本话题继续留在当前窗口。',
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: a.title } },
    elements,
  }
}

/** 结果通知卡（v2：折叠面板只有 2.0 有）。数据由 kernel/notice-card 组装，这里只管形状。 */
export function renderNoticeCard(a: {
  title: string
  cwd?: string
  time: string
  stats?: string
  userSaid?: string
  body: string
  continued?: boolean
}): unknown {
  const elements: Record<string, unknown>[] = []
  const quote = (text: string): string =>
    text
      .split('\n')
      .map((l) => `<font color='grey'>│ ${l}</font>`)
      .join('\n')
  if (!a.continued) {
    if (a.cwd) elements.push({ tag: 'markdown', content: `📁 \`${a.cwd}\`` })
    elements.push({ tag: 'markdown', content: `🕐 ${a.time}` })
    if (a.stats) elements.push({ tag: 'markdown', content: `📦 ${a.stats}` })
    if (a.userSaid) {
      const said = a.userSaid
      const clipped = said.length > 3000
      const shown = clipped ? `${said.slice(0, 3000)}\n…（原文共 ${said.length} 字，此处截断）` : said
      const compact = said.length <= 180 && !said.includes('\n')
      elements.push({ tag: 'hr' })
      if (compact) {
        elements.push({ tag: 'markdown', content: '💬 **你在终端里说**' })
        elements.push({ tag: 'markdown', content: quote(shown) })
      } else {
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: {
              tag: 'plain_text',
              content: `💬 你在终端里说：${(said.split('\n')[0] ?? '').slice(0, 40)}…（共 ${said.length} 字）`,
            },
            width: 'fill',
            icon_position: 'right',
            icon_expanded_angle: 180,
          },
          vertical_spacing: '4px',
          elements: [{ tag: 'markdown', content: quote(shown) }],
        })
      }
    }
    elements.push({ tag: 'hr' })
  }
  elements.push({ tag: 'markdown', content: a.body })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: a.title } },
    body: { elements },
  }
}

/** 回执卡：题答完之后原地把题卡改成这个，让人一眼看到「答案已经送回去了」。 */
export function renderSettledCard(a: { question?: string; answer?: string }): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '✅ 已把答案送回窗口' } },
    elements: [
      { tag: 'markdown', content: `**${a.question ?? ''}**` },
      { tag: 'markdown', content: `你的选择：\`${a.answer ?? ''}\`` },
    ],
  }
}

/** 工具授权卡：标题橙色、四个按钮，说清「不答一直等」。 */
export function renderPermissionCard(a: {
  id: string
  toolName: string
  detail: readonly string[]
  workspace?: string
  threadId?: string
  rootMessageId?: string
}): unknown {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '🔐 等你放行一个操作' },
    },
    elements: [
      { tag: 'markdown', content: `📁 \`${a.workspace ?? ''}\`` },
      { tag: 'markdown', content: `🔧 工具：\`${a.toolName}\`` },
      { tag: 'hr' },
      ...a.detail.map((t) => ({ tag: 'markdown', content: t })),
      { tag: 'hr' },
      ...([
        ['✅ 允许这一次', 'primary', { k: 'perm', qid: a.id, d: 'allow' }],
        ['✅ 允许，本会话不再问这个工具', 'default', { k: 'perm', qid: a.id, d: 'allow', always: true }],
        ['⛔ 拒绝', 'danger', { k: 'perm', qid: a.id, d: 'deny' }],
        ['🖥 我在电脑前，让终端问我', 'default', { k: 'hands', qid: a.id }],
      ] as const).map(([text, type, value]) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: text },
        type,
        width: 'fill',
        value,
      })),
      {
        tag: 'markdown',
        content:
          '「本会话不再问」会把规则写进本项目的 `.claude/settings.local.json`。\n' +
          '不答就一直等（最多 30 分钟）；期间你一回到电脑前，确认框会自动回到终端。',
      },
    ],
  }
}

export function renderQuestionCard(a: {
  id: string
  header?: string
  question: string
  options: readonly { label: string; description?: string }[]
  index: number
  total: number
  multiSelect: boolean
  chatId: string
  threadId?: string
  rootMessageId?: string
  /** 多选时已经勾上的项（原地刷新用，☑ / ☐） */
  selected?: readonly string[]
}): unknown {
  // 卡片最多放 20 个（参考项目 pickMax）；超出时下面会写清「共发现 N 个」
  const shown = a.options.slice(0, 20)
  const hidden = a.options.length - shown.length
  const picked = new Set(a.selected ?? [])
  const buttons = shown.map((o, i) => ({
    tag: 'button',
    text: {
      tag: 'plain_text',
      // 多选时把勾选态画在按钮上：不刷新卡片的话，人根本不知道自己选了没
      content: `${a.multiSelect ? (picked.has(o.label) ? '☑ ' : '☐ ') : ''}${i + 1}. ${o.label}`,
    },
    type: i === 0 ? 'primary' : 'default',
    value: { k: 'ans', qid: a.id, n: i, label: o.label },
  }))

  const head = `**${a.header ? `${a.header}：` : ''}${a.question}**`
  const counter = a.total > 1 ? `（第 ${a.index}/${a.total} 题）` : ''
  const tip = a.multiSelect
    ? '多选：点选项先攒着（再点一下取消），选完点「✅ 就这些」；也可以直接回文字「A, B」。'
    : '按钮点不动的话，直接回序号或文字也一样。'

  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: `需要你选一个${counter}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: head } },
      ...(a.options.length ? [{ tag: 'action', actions: buttons }] : []),
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: tip } },
      {
        tag: 'action',
        actions: [
          // 多选题：先点选项攒着，点这个才提交
          ...(a.multiSelect
            ? [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '✅ 就这些' },
                  type: 'primary',
                  value: { k: 'ansok', qid: a.id },
                },
              ]
            : []),
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🖥 我在电脑前，让终端问我' },
            type: 'default',
            value: { k: 'hands', qid: a.id },
          },
        ],
      },
    ],
  }
}
