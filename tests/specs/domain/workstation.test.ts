import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeWorkstation } from '../../../src/domain/workstation.ts'

test('工作站快照：会话/工作/发件箱按状态计数', () => {
  const src = {
    listSessions: () => [{ status: 'active' as const }, { status: 'active' as const }, { status: 'stopped' as const }],
    listWorksByStatus: (s: string) => (s === 'queued' ? [{}, {}] : []),
    countOutbox: (s: string) => (s === 'pending' ? 3 : 0),
  }
  const snap = summarizeWorkstation(src)
  assert.deepEqual(snap.sessions, { active: 2, stopped: 1 })
  assert.equal(snap.works.queued, 2)
  assert.equal(snap.works.running, 0)
  assert.equal(snap.outbox.pending, 3)
})
