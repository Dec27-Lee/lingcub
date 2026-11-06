/** 会话路由：话题内的话直接投给对应会话，不再走判断层。 */

import type { Session } from '../domain/types.ts'

export interface SessionLookup {
  findSessionByThread(chatId: string, threadId: string): Session | null
}

/**
 * 命中条件只有一条：这条消息落在某个已绑定会话的话题里。
 * 已死的会话不再接消息——宁可让用户重开，也不要把话投进没人读的地方。
 */
export function routeToSession(lookup: SessionLookup, chatId: string, threadId: string | undefined): Session | null {
  if (!threadId) return null
  const session = lookup.findSessionByThread(chatId, threadId)
  if (!session) return null
  return session.status === 'dead' ? null : session
}
