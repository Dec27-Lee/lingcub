/**
 * 渠道无关的卡片 JSON 构建：场景与控制台共用。
 * 只产出飞书交互卡片结构（v1 schema），不依赖任何插件。
 */

/** 恢复会话卡片：每条历史会话一个按钮，点哪个接哪个。 */
export function renderResumeCard(a: {
  items: readonly { label: string; sessionId: string; cwd: string; executor?: string }[]
  /** 已经绑了窗口时：选中后把这个会话改绑到本话题 */
  rebindSessionId?: string
  threadId?: string
  rootMessageId?: string
  chatId: string
  note?: string
  /** 接入正在跑的窗口：按钮回调用 attach，不启动新进程 */
  attach?: boolean
}): unknown {
  const buttons = a.items.slice(0, 8).map((it, i) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${i + 1}. ${it.label}` },
    type: i === 0 ? 'primary' : 'default',
    value: {
      k: a.attach ? 'attach' : 'resume',
      sid: it.sessionId,
      cwd: it.cwd,
      exec: it.executor ?? '',
      thread: a.threadId ?? '',
      root: a.rootMessageId ?? '',
      chat: a.chatId,
      rebind: a.rebindSessionId ?? '',
    },
  }))

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: a.attach ? '接入正在跑的窗口' : a.rebindSessionId ? '换会话' : '恢复会话' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            a.note ??
            (a.attach
              ? '下面是正在跑的窗口（按最近活动排序）。选一个，这个话题就接到它身上——不新开、不恢复，直接对它说话。'
              : '近 5 天、同工作区、且当前没在运行的会话。选一个，我把这个话题接到它上面继续。'),
        },
      },
      { tag: 'hr' },
      { tag: 'action', actions: buttons },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '按钮点不动的话，直接回序号也一样。' } },
    ],
  }
}

/**
 * 开窗第一步：选执行器。
 *
 * 先问执行器再问工作区，是因为两者能力不同（claude 默认开终端窗口、dsh 只有后台会话），
 * 选择结果要一路带进后面的卡与开窗请求，所以按钮 value 里直接带上 exec 与话题名。
 */
export function renderExecutorCard(a: {
  chatId: string
  title: string
  threadId?: string
  rootMessageId?: string
  note?: string
  /** 事件来源 id：一路带到开窗请求，会话才知道「结果该回哪」 */
  source?: string
}): unknown {
  const btn = (exec: 'claude' | 'dsh', label: string, type: 'primary' | 'default'): unknown => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: {
      k: 'exec',
      exec,
      thread: a.threadId ?? '',
      root: a.rootMessageId ?? '',
      chat: a.chatId,
      prompt: a.title,
      src: a.source ?? '',
    },
  })
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '新建窗口 · 选执行器' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**话题：${a.title}**` } },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: a.note ?? 'claude code 开本机终端窗口；dsh 起后台会话（没有可见终端，状态为推断）。',
        },
      },
      { tag: 'hr' },
      { tag: 'action', actions: [btn('claude', 'Claude Code 窗口', 'primary'), btn('dsh', 'DSH 后台会话', 'default')] },
    ],
  }
}

/** 开窗第二步：选工作区（真实目录，按最近活跃排序）。 */
export function renderWorkspaceCard(a: {
  chatId: string
  title: string
  executor: 'claude' | 'dsh'
  options: readonly { root: string; label: string; trusted?: boolean }[]
  threadId?: string
  rootMessageId?: string
  max?: number
  source?: string
}): unknown {
  // 要人工确认信任的排后面；标签上直说「首次要确认」，免得用户以为窗口坏了
  const ordered = [...a.options].sort((x, y) => Number(x.trusted === false) - Number(y.trusted === false))
  const shown = ordered.slice(0, a.max ?? 20)
  const buttons = shown.map((o, i) => ({
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: `${i + 1}. ${o.label}${o.trusted === false ? '（首次要在电脑上点一次确认）' : ''}`,
    },
    type: i === 0 ? 'primary' : 'default',
    value: {
      k: 'pick',
      workspaceId: o.root,
      exec: a.executor,
      prompt: a.title,
      thread: a.threadId ?? '',
      root: a.rootMessageId ?? '',
      chat: a.chatId,
      src: a.source ?? '',
    },
  }))
  const more = a.options.length > shown.length ? `\n共发现 ${a.options.length} 个，只列最近 ${shown.length} 个。` : ''
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `新建窗口 · 选工作区（${a.executor}）` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**话题：${a.title}**${more}` } },
      { tag: 'hr' },
      { tag: 'action', actions: buttons },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '按钮点不动的话，直接回序号也一样。' } },
    ],
  }
}
