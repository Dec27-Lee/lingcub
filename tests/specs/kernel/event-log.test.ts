import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Event } from '../../../src/domain/types.ts'

const silent = (): void => {}

function ev(id: string): Event {
  const at = '2026-11-03T00:00:00.000Z'
  return {
    id,
    source: 'source-test',
    externalId: id,
    receivedAt: at,
    occurredAt: at,
    actor: { id: 'u1' },
    channel: { kind: 'group', id: 'c1' },
    text: id,
    raw: { id },
  }
}

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'lingcub-eventlog-')), 'lingcub.db')
}

test('消息事件与事件史同事务写入，重复投递不追加', () => {
  const store = openStore(':memory:')
  try {
    assert.equal(store.insertEvent(ev('e1')), true)
    assert.equal(store.insertEvent(ev('e1')), false)
    assert.equal(store.countEvents(), 1)
    assert.equal(store.countEventLog(), 1)
    const log = store.getEventLog('e1')
    assert.ok(log)
    assert.equal(log.kind, 'message.received')
    assert.equal(log.source, 'source-test')
    assert.equal((log.payload as Event).text, 'e1')
    assert.equal((log.payload as { raw?: unknown }).raw, undefined)
  } finally {
    store.close()
  }
})

test('领域事件同 id 只落一次', () => {
  const store = openStore(':memory:')
  try {
    const bus = new EventLog(store, { log: silent })
    const a = bus.append({ id: 'turn:1', kind: 'session.turn.ended', source: 'kernel', payload: { turn: 1 } })
    const b = bus.append({ id: 'turn:1', kind: 'session.turn.ended', source: 'kernel', payload: { turn: 1 } })
    assert.equal(a.duplicate, false)
    assert.equal(b.duplicate, true)
    assert.equal(a.seq, b.seq)
    assert.equal(store.countEventLog(), 1)
  } finally {
    store.close()
  }
})

test('新订阅默认不回放历史；since=beginning 才回放', async () => {
  const store = openStore(':memory:')
  try {
    store.insertEvent(ev('old'))
    const bus = new EventLog(store, { log: silent })
    const seen: string[] = []
    bus.subscribe('p1', 'message.received', (e) => {
      seen.push(e.id)
    })
    store.insertEvent(ev('new'))
    await bus.tick()
    assert.deepEqual(seen, ['new'])

    const replay: string[] = []
    bus.subscribe(
      'p2',
      'message.received',
      (e) => {
        replay.push(e.id)
      },
      { since: 'beginning' },
    )
    await bus.tick()
    assert.deepEqual(replay, ['old', 'new'])
  } finally {
    store.close()
  }
})

test('游标持久化：关库重开后只投剩下的', async () => {
  const path = tempDb()
  const first = openStore(path)
  first.insertEvent(ev('e1'))
  first.insertEvent(ev('e2'))
  const bus1 = new EventLog(first, { log: silent })
  const seen1: string[] = []
  bus1.subscribe(
    'p',
    'message.received',
    (e) => {
      seen1.push(e.id)
    },
    { since: 'beginning' },
  )
  await bus1.tick(1)
  assert.deepEqual(seen1, ['e1'])
  first.close()

  const second = openStore(path)
  try {
    const bus2 = new EventLog(second, { log: silent })
    const seen2: string[] = []
    bus2.subscribe(
      'p',
      'message.received',
      (e) => {
        seen2.push(e.id)
      },
      { since: 'beginning' },
    )
    await bus2.tick()
    assert.deepEqual(seen2, ['e2'])
  } finally {
    second.close()
  }
})

test('全局串行：前一个订阅处理完才轮到下一个', async () => {
  const store = openStore(':memory:')
  try {
    store.insertEvent(ev('e1'))
    const bus = new EventLog(store, { log: silent })
    const order: string[] = []
    bus.subscribe(
      'a',
      'message.received',
      async () => {
        order.push('a-start')
        await new Promise((r) => setTimeout(r, 5))
        order.push('a-end')
      },
      { since: 'beginning' },
    )
    bus.subscribe(
      'b',
      'message.received',
      () => {
        order.push('b')
      },
      { since: 'beginning' },
    )
    await bus.tick()
    assert.deepEqual(order, ['a-start', 'a-end', 'b'])
  } finally {
    store.close()
  }
})

test('失败退避：未到点不重试，到点后重试成功', async () => {
  let clock = 1_000_000
  const store = openStore(':memory:')
  try {
    store.insertEvent(ev('e1'))
    let calls = 0
    const bus = new EventLog(store, {
      log: silent,
      now: () => clock,
      backoffBaseMs: 100,
      maxAttempts: 3,
    })
    bus.subscribe(
      'p',
      'message.received',
      () => {
        calls++
        if (calls === 1) throw new Error('第一次失败')
      },
      { since: 'beginning' },
    )
    assert.deepEqual(await bus.tick(), { delivered: 0, retried: 1, dead: 0, skipped: 0 })
    assert.equal(store.countDeliveries('pending'), 1)
    // 未到退避点：不重试
    assert.equal((await bus.tick()).delivered, 0)
    // 前推到点：重试成功
    clock += 101
    assert.deepEqual(await bus.tick(), { delivered: 1, retried: 0, dead: 0, skipped: 0 })
    assert.equal(store.countDeliveries(), 0)
  } finally {
    store.close()
  }
})

test('死信越过游标：毒事件不卡后续，死信行保留', async () => {
  const store = openStore(':memory:')
  try {
    store.insertEvent(ev('bad'))
    store.insertEvent(ev('good'))
    const bus = new EventLog(store, { log: silent, maxAttempts: 1 })
    const seen: string[] = []
    bus.subscribe(
      'p',
      'message.received',
      (e) => {
        if (e.id === 'bad') throw new Error('毒事件')
        seen.push(e.id)
      },
      { since: 'beginning' },
    )
    const r = await bus.tick()
    assert.equal(r.dead, 1)
    assert.equal(r.delivered, 1)
    assert.deepEqual(seen, ['good'])
    assert.equal(store.countDeliveries('dead'), 1)
  } finally {
    store.close()
  }
})

test('handler 超时按失败处理，不冻住整个 tick', async () => {
  const store = openStore(':memory:')
  try {
    store.insertEvent(ev('slow'))
    store.insertEvent(ev('next'))
    const bus = new EventLog(store, { log: silent, maxAttempts: 1, handlerTimeoutMs: 5 })
    const seen: string[] = []
    bus.subscribe(
      'p',
      'message.received',
      async (e) => {
        if (e.id === 'slow') await new Promise((r) => setTimeout(r, 50))
        seen.push(e.id)
      },
      { since: 'beginning' },
    )
    const r = await bus.tick()
    assert.equal(r.dead, 1)
    assert.deepEqual(seen, ['next'])
  } finally {
    store.close()
  }
})

test('死信越过游标是持久化的：重开库不重投毒事件', async () => {
  const path = tempDb()
  const first = openStore(path)
  first.insertEvent(ev('bad'))
  const bus1 = new EventLog(first, { log: silent, maxAttempts: 1 })
  bus1.subscribe(
    'p',
    'message.received',
    () => {
      throw new Error('毒事件')
    },
    { since: 'beginning' },
  )
  const r = await bus1.tick()
  assert.equal(r.dead, 1)
  assert.equal(r.delivered, 0)
  first.close()

  const second = openStore(path)
  try {
    const bus2 = new EventLog(second, { log: silent, maxAttempts: 1 })
    const seen: string[] = []
    bus2.subscribe(
      'p',
      'message.received',
      (e) => {
        seen.push(e.id)
      },
      { since: 'beginning' },
    )
    const r2 = await bus2.tick()
    assert.equal(r2.delivered, 0)
    assert.equal(r2.dead, 0)
    assert.deepEqual(seen, [])
  } finally {
    second.close()
  }
})

test('滞后超限冻结订阅；积压超上限跳过不补投', async () => {
  const store = openStore(':memory:')
  try {
    for (const id of ['e1', 'e2', 'e3', 'e4']) store.insertEvent(ev(id))
    const bus = new EventLog(store, { log: silent, maxLag: 2 })
    bus.subscribe('p', 'message.received', () => {}, { since: 'beginning' })
    const frozen = await bus.tick()
    assert.equal(frozen.delivered, 0)
    assert.equal(store.getSubscription('p', 'message.received')?.enabled, 0)

    const store2 = openStore(':memory:')
    try {
      for (const id of ['a', 'b', 'c', 'd']) store2.insertEvent(ev(id))
      const bus2 = new EventLog(store2, { log: silent, maxCatchUp: 1 })
      const seen: string[] = []
      bus2.subscribe(
        'p',
        'message.received',
        (e) => {
          seen.push(e.id)
        },
        { since: 'beginning' },
      )
      const r = await bus2.tick()
      assert.equal(r.skipped, 4)
      assert.deepEqual(seen, [])
    } finally {
      store2.close()
    }
  } finally {
    store.close()
  }
})

test('prune：只删游标前且无未决投递的事件；死信事件保留', async () => {
  const store = openStore(':memory:')
  try {
    store.insertEvent(ev('e1'))
    const bus = new EventLog(store, { log: silent, maxAttempts: 1 })
    bus.subscribe('ok', 'message.received', () => {}, { since: 'beginning' })
    await bus.tick()
    store.insertEvent(ev('e2'))
    const pruned = bus.prune(0)
    assert.equal(pruned.events, 1)
    assert.equal(store.getEventLog('e1'), null)
    assert.ok(store.getEventLog('e2'))

    store.insertEvent(ev('e3'))
    const bus2 = new EventLog(store, { log: silent, maxAttempts: 1 })
    bus2.subscribe(
      'bad',
      'message.received',
      () => {
        throw new Error('fail')
      },
      { since: 'beginning' },
    )
    await bus2.tick()
    assert.equal(store.countDeliveries('dead'), 2)
    const pruned2 = bus2.prune(0)
    assert.equal(pruned2.events, 0)
    assert.ok(store.getEventLog('e3'))
  } finally {
    store.close()
  }
})

test('崩溃恢复：dispatched 回到 pending 且 attempts 不归零', () => {
  const store = openStore(':memory:')
  try {
    store.insertEvent(ev('e1'))
    const bus = new EventLog(store, { log: silent })
    bus.subscribe('p', 'message.received', () => {}, { since: 'beginning' })
    store.markDeliveryDispatched('p', 'message.received', 1, 3)
    assert.equal(bus.recover(), 1)
    const d = store.getDelivery('p', 'message.received', 1)
    assert.equal(d?.status, 'pending')
    assert.equal(d?.attempts, 3)
  } finally {
    store.close()
  }
})
