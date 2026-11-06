/** 工作站快照：只做计数，不读正文；面板与能力共用。 */

export type SessionStatus = 'active' | 'idle' | 'stopped' | 'dead'
export type WorkStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type OutboxStatus = 'pending' | 'dispatched' | 'done' | 'dead' | 'unknown'

export interface WorkstationSource {
  listSessions(): { status: SessionStatus }[]
  listWorksByStatus(status: WorkStatus): unknown[]
  countOutbox(status: OutboxStatus): number
}

export interface WorkstationSnapshot {
  sessions: Record<string, number>
  works: Record<string, number>
  outbox: Record<string, number>
}

export function summarizeWorkstation(src: WorkstationSource): WorkstationSnapshot {
  const sessions: Record<string, number> = {}
  for (const s of src.listSessions()) sessions[s.status] = (sessions[s.status] ?? 0) + 1
  const works: Record<string, number> = {}
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
    works[status] = src.listWorksByStatus(status).length
  }
  const outbox: Record<string, number> = {}
  for (const status of ['pending', 'dispatched', 'done', 'dead', 'unknown'] as const) {
    outbox[status] = src.countOutbox(status)
  }
  return { sessions, works, outbox }
}
