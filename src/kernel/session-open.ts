/**
 * P2.6 开窗事件的内核侧：
 *   session.open 提交 → open_session 发件箱动作 → 落请求 + session.open.requested
 *   执行器插件真正开窗后发 session.opened / session.open.failed
 *   内核落会话行、更新工作项，发 session.ready
 *
 * 这里只处理状态与事件，不碰任何终端/执行器。
 */

import {
  SESSION_OPEN_FAILED,
  SESSION_OPEN_REQUESTED,
  SESSION_OPENED,
  SESSION_READY,
  SESSION_TURN_ENDED,
} from '../domain/events.ts'
import type { Log } from '../domain/ports.ts'
import type { SessionOpenMode, SessionOpenRequest, SessionOpened, Work } from '../domain/types.ts'
import type { EventLog } from './event-log.ts'
import { eventId } from './ids.ts'
import type { Store } from './store.ts'

export function requestSessionOpen(deps: {
  store: Store
  eventLog: EventLog
  work: Work
  mode: SessionOpenMode
  log: Log
}): { requestId: string } {
  const request: SessionOpenRequest = { requestId: deps.work.id, work: deps.work, mode: deps.mode }
  deps.store.insertSessionOpen(request)
  deps.eventLog.append({
    id: `session-open:${request.requestId}`,
    kind: SESSION_OPEN_REQUESTED,
    source: 'kernel',
    subject: request.requestId,
    payload: request,
  })
  deps.log('info', `开窗请求已落：${request.requestId}（${request.mode}/${request.work.executor}）`)
  return { requestId: request.requestId }
}

export function registerSessionOpenHandlers(deps: {
  store: Store
  eventLog: EventLog
  log: Log
}): void {
  const { store, eventLog, log } = deps

  eventLog.subscribe('kernel.session-open', SESSION_OPENED, async (e) => {
    const opened = e.payload as SessionOpened
    const row = store.getSessionOpen(opened.requestId)
    if (!row) {
      log('warn', `session.opened 找不到开窗请求：${opened.requestId}`)
      return
    }
    if (row.status === 'opened') return
    const work = row.request.work
    const origin = work.origin
    const now = new Date().toISOString()
    const sessionRowId = origin?.rebindSessionId ?? `sess-${work.id}`

    if (origin?.rebindSessionId) {
      store.rebindSession(origin.rebindSessionId, opened.sessionId, work.project)
    } else if (!store.getSession(sessionRowId)) {
      store.insertSession({
        id: sessionRowId,
        chatId: origin?.chatId ?? '',
        source: origin?.source,
        threadId: origin?.threadId ?? origin?.rootMessageId,
        rootMessageId: origin?.rootMessageId,
        ownerId: work.ownerId,
        title: origin?.title?.trim() || work.prompt.slice(0, 40),
        executor: opened.executor,
        // 存执行器真实 cwd，不是工作区名：之后 post/stop 要拿它当 cwd 用，
        // 存成 project id 会让「在话题里继续说话」直接失败。
        workspace: opened.cwd || work.workspace,
        sessionId: opened.sessionId,
        status: 'active',
        createdAt: now,
        lastActiveAt: now,
      })
    }
    store.setWorkStatus(work.id, 'running', opened.sessionId)
    store.setSessionOpenStatus(opened.requestId, 'opened', { sessionId: opened.sessionId })
    eventLog.append({
      id: eventId('session-ready', opened.requestId),
      kind: SESSION_READY,
      source: 'kernel',
      subject: sessionRowId,
      causedBy: e.id,
      payload: {
        requestId: opened.requestId,
        sessionRowId,
        executor: opened.executor,
        sessionId: opened.sessionId,
        cwd: opened.cwd,
        chatId: origin?.chatId,
        source: origin?.source,
        threadId: origin?.threadId,
        rootMessageId: origin?.rootMessageId,
        title: origin?.title,
        project: work.project,
      },
    })
    log('info', `会话已就绪：${sessionRowId} ↔ ${opened.executor}/${opened.sessionId}`)
  })

  eventLog.subscribe('kernel.session-open', SESSION_OPEN_FAILED, async (e) => {
    const p = e.payload as { requestId: string; reason?: string }
    const row = store.getSessionOpen(p.requestId)
    if (!row) {
      log('warn', `session.open.failed 找不到开窗请求：${p.requestId}`)
      return
    }
    store.setSessionOpenStatus(p.requestId, 'failed', { error: p.reason ?? 'open failed' })
    store.setWorkStatus(row.request.work.id, 'failed')
    log('warn', `开窗失败：${p.requestId} — ${p.reason ?? '未知原因'}`)
  })

  eventLog.subscribe('kernel.session-turns', SESSION_TURN_ENDED, async (e) => {
    const p = e.payload as { sessionId?: string }
    if (p.sessionId) store.bumpSessionTurn(p.sessionId)
  })
}
