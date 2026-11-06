import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EventLog } from '../src/kernel/event-log.ts'
import { emitAskRequested, emitPermissionRequested } from '../src/kernel/hook-events.ts'

function fakeLog(): { log: EventLog; rows: Parameters<EventLog['append']>[0][] } {
  const rows: Parameters<EventLog['append']>[0][] = []
  const log = {
    append: (e: Parameters<EventLog['append']>[0]) => {
      rows.push(e)
      return { seq: rows.length, duplicate: false }
    },
  } as unknown as EventLog
  return { log, rows }
}

test('选择题事件：kind/自然键/题目都带上', () => {
  const { log, rows } = fakeLog()
  emitAskRequested(log, {
    sessionId: 'sess-1',
    executorSessionId: 'exec-1',
    questionId: 'q-1',
    questions: [{ question: '选哪个' }],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.kind, 'session.ask.requested')
  assert.equal(rows[0]?.id, 'ask:q-1')
  assert.equal(rows[0]?.subject, 'sess-1')
  assert.deepEqual((rows[0]?.payload as { questions: unknown }).questions, [{ question: '选哪个' }])
})

test('授权事件：kind/自然键/工具名都带上', () => {
  const { log, rows } = fakeLog()
  emitPermissionRequested(log, {
    sessionId: 'sess-1',
    executorSessionId: 'exec-1',
    questionId: 'perm-1',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.kind, 'session.permission.requested')
  assert.equal(rows[0]?.id, 'perm:perm-1')
  assert.equal((rows[0]?.payload as { toolName?: string }).toolName, 'Bash')
})
