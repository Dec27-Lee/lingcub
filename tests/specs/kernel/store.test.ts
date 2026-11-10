import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Event } from '../../../src/domain/types.ts'
import { eventId } from '../../../src/kernel/ids.ts'
import { openStore } from '../../../src/kernel/store.ts'

function ev(externalId = 'm1'): Event {
  return {
    id: eventId('dingtalk-im', externalId),
    source: 'dingtalk-im',
    externalId,
    receivedAt: '2026-11-03T09:00:00.000Z',
    occurredAt: '2026-11-03T08:59:58.000Z',
    atMe: true,
    actor: { id: 'u1', name: 'Yue' },
    channel: { kind: 'group', id: 'g1', name: '研发群' },
    text: '登录页报错了',
    raw: { msgId: externalId, nested: { a: 1 } },
  }
}

test('同一条 Event 插两次只有一行（内容派生 id 幂等）', () => {
  const store = openStore(':memory:')
  try {
    assert.equal(store.insertEvent(ev()), true)
    assert.equal(store.insertEvent(ev()), false)
    assert.equal(store.countEvents(), 1)
  } finally {
    store.close()
  }
})

test('traceMessage：返回原始事件与同 id 的事件史、发件箱', () => {
  const store = openStore(':memory:')
  try {
    const e = ev('trace-1')
    store.insertEvent(e)
    store.insertSession({
      id: 'sess-trace',
      chatId: 'g1',
      source: 'source-feishu-im',
      rootMessageId: e.id,
      executor: 'claude',
      workspace: 'proj',
      status: 'active',
      createdAt: '2026-11-03T09:00:00.000Z',
      lastActiveAt: '2026-11-03T09:00:00.000Z',
    })
    store.appendEventLog({
      id: 'turn-trace',
      kind: 'session.turn.ended',
      source: 'kernel',
      at: '2026-11-03T09:01:00.000Z',
      payload: { sessionId: 'sess-trace', text: '已修好' },
    })
    const trace = store.traceMessage(e.id)
    assert.equal(trace.event?.id, e.id)
    assert.equal(trace.events[0]?.id, e.id)
    assert.equal(trace.sessions[0]?.id, 'sess-trace')
    assert.equal(trace.sessions[0]?.source, 'source-feishu-im')
    assert.equal((trace.outcomes[0]?.payload as { text?: string }).text, '已修好')
    assert.deepEqual(trace.outbox, [])
  } finally {
    store.close()
  }
})

test('degradedAnalyses：只返回最新一次仍降级的消息', () => {
  const store = openStore(':memory:')
  try {
    const e = ev('degraded-1')
    store.insertEvent(e)
    const at = new Date().toISOString()
    store.appendEventLog({
      id: 'analysis:deg-1',
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      at,
      payload: {
        event: e,
        analysis: { eventId: e.id, attempt: 1, summary: '', status: 'degraded', contextCount: 0 },
      },
    })
    assert.equal(store.degradedAnalyses(new Date(Date.now() - 60_000).toISOString())[0]?.event.id, e.id)

    store.appendEventLog({
      id: 'analysis:deg-1:r1',
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      at: new Date().toISOString(),
      payload: {
        event: e,
        analysis: { eventId: e.id, attempt: 2, summary: '已恢复', status: 'ok', contextCount: 0 },
      },
    })
    assert.equal(store.degradedAnalyses(new Date(Date.now() - 60_000).toISOString()).length, 0)
  } finally {
    store.close()
  }
})

test('retryDeadOutbox：只把 dead 行放回 pending', () => {
  const store = openStore(':memory:')
  try {
    store.enqueue({ kind: 'reply_only', text: 'x' }, 'dead-key')
    const row = store.pendingOutbox(1)[0]
    assert.ok(row)
    store.markOutbox(row.id, 'dead', 3, 'x')
    assert.equal(store.retryDeadOutbox(row.id), true)
    assert.equal(store.pendingOutbox(1)[0]?.id, row.id)
    assert.equal(store.retryDeadOutbox(row.id), false)
  } finally {
    store.close()
  }
})

test('countAnalysis：按状态统计最近分析事件', () => {
  const store = openStore(':memory:')
  try {
    const since = new Date(Date.now() - 60_000).toISOString()
    store.appendEventLog({
      id: 'analysis:count',
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      at: new Date().toISOString(),
      payload: { event: ev('count'), analysis: { status: 'degraded' } },
    })
    assert.equal(store.countAnalysis('degraded', since), 1)
    assert.equal(store.countAnalysis('ok', since), 0)
  } finally {
    store.close()
  }
})

test('latestAnalysis：重试后取最新一次，而不是首轮', () => {
  const store = openStore(':memory:')
  try {
    const e = ev('latest-1')
    store.appendEventLog({
      id: `analysis:${e.id}`,
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      at: new Date().toISOString(),
      payload: { event: e, analysis: { eventId: e.id, attempt: 1, summary: '旧', status: 'degraded' } },
    })
    store.appendEventLog({
      id: `analysis:${e.id}:r1`,
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      at: new Date().toISOString(),
      payload: { event: e, analysis: { eventId: e.id, attempt: 2, summary: '新', status: 'ok' } },
    })
    assert.equal(store.latestAnalysis(e.id)?.summary, '新')
    assert.equal(store.latestAnalysis(e.id)?.attempt, 2)
  } finally {
    store.close()
  }
})

test('recentAnalyses：按会话取此前几条成功分析，旧→新，降级的不喂回模型', () => {
  const store = openStore(':memory:')
  try {
    const base = ev('recent-1')
    store.appendEventLog({
      id: `analysis:${base.id}`,
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      subject: 'g1',
      at: '2026-11-03T08:10:00.000Z',
      payload: {
        event: base,
        analysis: { eventId: base.id, summary: '开始降级处理', points: ['redis 80%'], urgency: 'high', status: 'ok', contextCount: 0 },
      },
    })
    // 降级记录没有结论，不能当成「此前的分析」喂回去
    store.appendEventLog({
      id: 'analysis:degraded-1',
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      subject: 'g1',
      at: '2026-11-03T08:20:00.000Z',
      payload: { event: base, analysis: { eventId: base.id, summary: '', status: 'degraded', contextCount: 0 } },
    })
    store.appendEventLog({
      id: 'analysis:recent-2',
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      subject: 'g1',
      at: '2026-11-03T08:30:00.000Z',
      payload: {
        event: base,
        analysis: { eventId: base.id, summary: '对账单接口已初始化', status: 'ok', contextCount: 0 },
      },
    })

    const rows = store.recentAnalyses('g1', '2026-11-03T09:00:00.000Z', 5)
    assert.deepEqual(
      rows.map((r) => r.summary),
      ['开始降级处理', '对账单接口已初始化'],
      '旧→新，且跳过降级记录',
    )
    assert.deepEqual(rows[0]?.points, ['redis 80%'])
    assert.equal(rows[0]?.urgency, 'high')
    // before 之前的才算「此前」：截断到 08:20 就只剩第一条
    assert.deepEqual(
      store.recentAnalyses('g1', '2026-11-03T08:25:00.000Z', 5).map((r) => r.summary),
      ['开始降级处理'],
    )
    // 别的会话不串
    assert.deepEqual(store.recentAnalyses('g2', undefined, 5), [])
  } finally {
    store.close()
  }
})

test('countEventsWithoutAnalysis：统计早于窗口且完全无分析的消息', () => {
  const store = openStore(':memory:')
  try {
    const e = ev('backlog-1')
    e.receivedAt = '2026-11-03T08:00:00.000Z'
    store.insertEvent(e)
    assert.equal(store.countEventsWithoutAnalysis('2026-11-03T09:00:00.000Z'), 1)
    store.appendEventLog({
      id: `analysis:${e.id}`,
      kind: 'message.analyzed',
      source: 'scenario-analysis',
      at: '2026-11-03T08:01:00.000Z',
      payload: { event: e, analysis: { eventId: e.id, summary: 'ok', status: 'ok', contextCount: 0 } },
    })
    assert.equal(store.countEventsWithoutAnalysis('2026-11-03T09:00:00.000Z'), 0)
  } finally {
    store.close()
  }
})

test('oldEventsWithoutAnalysis：只取窗口外缺口，按时间正序', () => {
  const store = openStore(':memory:')
  try {
    const a = ev('old-a')
    a.receivedAt = '2026-11-03T07:00:00.000Z'
    const b = ev('old-b')
    b.receivedAt = '2026-11-03T08:00:00.000Z'
    store.insertEvent(b)
    store.insertEvent(a)
    const rows = store.oldEventsWithoutAnalysis('2026-11-03T09:00:00.000Z', 10)
    assert.deepEqual(rows.map((x) => x.externalId), ['old-a', 'old-b'])
  } finally {
    store.close()
  }
})

test('outbox.eventId：按事件关联，不依赖 dedupe 字符串', () => {
  const store = openStore(':memory:')
  try {
    const e = ev('outbox-event')
    store.insertEvent(e)
    store.enqueue({ kind: 'reply_only', text: '回执' }, 'opaque-key', { eventId: e.id })
    const trace = store.traceMessage(e.id)
    assert.equal(trace.outbox[0]?.dedupeKey, 'opaque-key')
    assert.equal((trace.outbox[0]?.action as { kind?: string }).kind, 'reply_only')
  } finally {
    store.close()
  }
})

test('findEventByExternalId：按平台消息 id 找回归一事件', () => {
  const store = openStore(':memory:')
  try {
    const e = ev('external-1')
    store.insertEvent(e)
    assert.equal(store.findEventByExternalId('external-1')?.id, e.id)
    assert.equal(store.findEventByExternalId('missing'), null)
  } finally {
    store.close()
  }
})

test('不同 externalId 各占一行', () => {
  const store = openStore(':memory:')
  try {
    store.insertEvent(ev('m1'))
    store.insertEvent(ev('m2'))
    assert.equal(store.countEvents(), 2)
  } finally {
    store.close()
  }
})

test('读回的事件字段与原始一致（含 atMe 与 raw）', () => {
  const store = openStore(':memory:')
  try {
    const e = ev()
    store.insertEvent(e)
    assert.deepEqual(store.getEvent(e.id), e)
  } finally {
    store.close()
  }
})

test('迁移只跑一次：重开数据库版本不变、数据还在', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lingcub-db-')), 'lingcub.db')
  const first = openStore(path)
  first.insertEvent(ev())
  first.close()

  const second = openStore(path)
  try {
    assert.equal(second.countEvents(), 1)
  } finally {
    second.close()
  }
})

test('同一 Work 重放不覆盖已有状态（不把 running 打回 queued）', () => {
  const store = openStore(':memory:')
  try {
    const e = ev()
    store.insertEvent(e)
    store.insertIntent({
      eventId: e.id,
      kind: 'bug',
      topic: '登录页报错',
      suggestedAction: 'dispatch_session',
      rationale: '规则 keyword-bug 命中',
      confidence: 0.8,
      byRule: 'keyword-bug',
    })
    const work = {
      id: 'w1',
      intentId: e.id,
      kind: 'session' as const,
      project: 'personal-lingcub',
      executor: 'dsh' as const,
      workspace: 'E:\\Develop_E\\lingcub',
      prompt: 'p',
      status: 'queued' as const,
    }
    assert.equal(store.insertWork(work), true)
    store.setWorkStatus('w1', 'running', 'sess-1')
    assert.equal(store.insertWork(work), false)
  } finally {
    store.close()
  }
})

test('迁移：会话表该有的列一个都不能少（改历史迁移会漏列，这条守着）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-cols-'))
  const file = join(dir, 'db.sqlite')
  const s1 = openStore(file)
  s1.close()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  const cols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name))
  db.close()
  for (const need of ['owner_id', 'root_message_id', 'last_stop_at', 'last_text', 'auto_reply_at']) {
    assert.ok(cols.has(need), `sessions 缺列 ${need}（迁移被改过？只能追加）`)
  }
})

test('迁移：库版本等于迁移条数，重复打开不报错（迁移只能追加）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-mig-'))
  const file = join(dir, 'db.sqlite')
  const s1 = openStore(file)
  s1.close()
  const s2 = openStore(file)
  s2.close()

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  db.close()
  assert.ok(v >= 8, `迁移要做完（当前 ${v}）`)
  // 关键：message_map（引用路由用）必须真的建出来
  const s3 = openStore(file)
  s3.mapMessage('om_x', 'sess-1', 'oc_1')
  assert.equal(s3.sessionByMessage('om_x'), null, '会话不存在时返回 null，不抛')
  s3.close()
})

test('迁移只许追加：老库（缺最后一版）打开后新列必须补上', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { openStore } = await import('../../../src/kernel/store.ts')

  const dir = mkdtempSync(join(tmpdir(), 'lingcub-mig-'))
  const file = join(dir, 'old.db')

  // 先用当前代码建一个完整库，再把「最后一版」的效果撤掉，模拟上一版留下的库：
  // 少了 not_before 列，user_version 也退一格。
  const first = openStore(file)
  first.close()
  const raw = new DatabaseSync(file)
  raw.exec('ALTER TABLE outbox DROP COLUMN not_before')
  const v = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  raw.exec(`PRAGMA user_version = ${Math.max(0, v - 1)}`)
  raw.close()

  // 重新打开：迁移应当把缺的那一列补回来（追加在末尾才做得到）
  const store = openStore(file)
  try {
    store.enqueue({ kind: 'post_message', sessionId: 's', text: 'x' }, 'k1', { notBefore: Date.now() + 5000 })
    assert.equal(store.pendingOutbox(10).length, 0, '未到点的不出队')
  } finally {
    store.close()
  }
})

test('一次性会话登记：按 id 幂等记，按 TTL 取，清过的不再取', () => {
  const store = openStore(':memory:')
  try {
    store.recordSpawn('sid-a', 'claude', 'analyze')
    store.recordSpawn('sid-b', 'dsh', 'classify')
    store.recordSpawn('sid-a', 'claude', 'analyze') // 同一次调用重复记账不该多一条
    assert.deepEqual(store.countSpawns(), { total: 2, pending: 2 })

    // 还没到期的取不出来
    assert.deepEqual(store.listSpawnsToPurge(new Date(Date.now() - 60_000).toISOString()), [])

    const future = new Date(Date.now() + 1000).toISOString()
    assert.deepEqual(
      store.listSpawnsToPurge(future).map((r) => r.sessionId).sort(),
      ['sid-a', 'sid-b'],
    )
    store.markSpawnPurged('sid-a')
    assert.deepEqual(
      store.listSpawnsToPurge(future).map((r) => r.sessionId),
      ['sid-b'],
      '清过的不再重复出现',
    )
    assert.deepEqual(store.countSpawns(), { total: 2, pending: 1 })

    // 到期数和「未清理数」是两个口径：前者看 created_at，后者不看
    assert.equal(store.countSpawnsDue(new Date(Date.now() - 60_000).toISOString()), 0, '还在保留期内')
    assert.equal(store.countSpawnsDue(future), 1, '只剩没清过的那一条')
  } finally {
    store.close()
  }
})
