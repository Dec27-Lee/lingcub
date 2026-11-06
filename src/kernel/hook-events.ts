/** 钩子事件 → event_log 的纯写入函数（runtime 内联处调用，便于单测）。 */

import type { EventLog } from './event-log.ts'

export function emitAskRequested(
  eventLog: EventLog,
  input: { sessionId: string; executorSessionId: string; questionId: string; questions: unknown },
): void {
  eventLog.append({
    id: `ask:${input.questionId}`,
    kind: 'session.ask.requested',
    source: 'kernel',
    subject: input.sessionId,
    payload: {
      sessionId: input.sessionId,
      executorSessionId: input.executorSessionId,
      questionId: input.questionId,
      questions: input.questions,
    },
  })
}

export function emitPermissionRequested(
  eventLog: EventLog,
  input: {
    sessionId: string
    executorSessionId: string
    questionId: string
    toolName?: string
    toolInput?: unknown
  },
): void {
  eventLog.append({
    id: `perm:${input.questionId}`,
    kind: 'session.permission.requested',
    source: 'kernel',
    subject: input.sessionId,
    payload: {
      sessionId: input.sessionId,
      executorSessionId: input.executorSessionId,
      questionId: input.questionId,
      toolName: input.toolName,
      toolInput: input.toolInput,
    },
  })
}
