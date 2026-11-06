/**
 * 话题里的命令：以 `#` 开头的第一行才算命令，其它内容照常投给窗口。
 * 只认固定几个词，认不出就当普通消息——绝不猜用户想干什么。
 */

export type SessionCommand =
  | { kind: 'stop' }
  | { kind: 'resume' }
  | { kind: 'newwin' }
  /** 把当前话题接到一个**正在跑**的窗口上（不另开、不恢复） */
  | { kind: 'attach' }
  | { kind: 'new' }
  | { kind: 'pin' }
  | { kind: 'unpin' }
  | { kind: 'status' }
  | { kind: 'help' }

const TABLE: Record<string, SessionCommand> = {
  '#stop': { kind: 'stop' },
  '#resume': { kind: 'resume' },
  '#恢复': { kind: 'resume' },
  '#继续': { kind: 'resume' },
  '#new': { kind: 'new' },
  '#新窗': { kind: 'newwin' },
  '#再开': { kind: 'newwin' },
  '#newwin': { kind: 'newwin' },
  '#接入': { kind: 'attach' },
  '#连上': { kind: 'attach' },
  '#attach': { kind: 'attach' },
  '#新窗口': { kind: 'new' },
  '#停': { kind: 'stop' },
  '#pin': { kind: 'pin' },
  '#置顶': { kind: 'pin' },
  '#unpin': { kind: 'unpin' },
  '#取消置顶': { kind: 'unpin' },
  '#status': { kind: 'status' },
  '#状态': { kind: 'status' },
  '#help': { kind: 'help' },
  '#帮助': { kind: 'help' },
}

export function parseCommand(text: string): SessionCommand | null {
  const first = text.trim().split('\n')[0]?.trim().toLowerCase()
  if (!first || !first.startsWith('#')) return null
  const exact = TABLE[first]
  if (exact) return exact
  // 前缀匹配：`#resume 一下` 也该当成命令，而不是当作正文投给窗口
  // （参考项目 /^#(resume|恢复|继续)(\s|$)/i 就是这个口径）
  const head = first.split(/\s+/)[0]
  return head ? (TABLE[head] ?? null) : null
}

/**
 * `#E:\path\...` 这样的整行：直接当绝对路径开窗（参考项目 newtask 的同一分支）。
 * 只认 Windows 盘符或 POSIX 绝对路径，认不出不算命令。
 */
export function parseAbsolutePathCommand(text: string): string | null {
  const first = text.trim().split('\n')[0]?.trim() ?? ''
  if (!first.startsWith('#')) return null
  const rest = first.slice(1).trim()
  if (!/^[a-zA-Z]:[\\/]/.test(rest) && !/^\//.test(rest)) return null
  return rest
}

export const HELP_TEXT = [
  '可用命令（在窗口话题里发）：',
  '#stop 停止这个窗口',
  '#resume 把这个窗口恢复成进行中（底层会话还在才有用）',
  '#new 关掉当前窗口，下一条消息会开一个新窗口',
  '#新窗 另起一棵新话题再开一个窗口（本话题保持不动）',
  '#pin / #unpin 置顶或取消置顶状态卡',
  '#status 看这个窗口的状态',
  '#help 看这份说明',
  '其它内容都会当成话发给窗口。',
].join('\n')
