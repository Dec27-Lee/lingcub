import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { Capabilities, CapabilityNotFoundError } from '../../../src/kernel/capabilities.ts'
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

test('remove：注销能力后 call 报未知能力，重复 remove 返回 false', async () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    caps.provide(
      { name: 'feishu.ping', effect: 'none', input: z.object({}) },
      () => ({ ok: true }),
      { provider: 'channel-feishu' },
    )
    assert.equal(caps.has('feishu.ping'), true)
    assert.equal(caps.providerOf('feishu.ping'), 'channel-feishu')

    assert.equal(caps.remove('feishu.ping'), true)
    assert.equal(caps.has('feishu.ping'), false)
    assert.deepEqual(caps.list(), [])
    await assert.rejects(caps.call('feishu.ping', {}, { caller: 'test' }), (err: unknown) => {
      assert.ok(err instanceof CapabilityNotFoundError)
      assert.match((err as Error).message, /能力未注册/)
      return true
    })
    // 反复卸载幂等
    assert.equal(caps.remove('feishu.ping'), false)
    assert.equal(caps.remove('never.provided'), false)
    // 卸载不丢提供者归属；同名可以重新注册并恢复 call
    assert.equal(caps.providerOf('feishu.ping'), 'channel-feishu')
    caps.provide(
      { name: 'feishu.ping', effect: 'none', input: z.object({}) },
      () => ({ ok: true }),
      { provider: 'channel-feishu' },
    )
    assert.deepEqual(await caps.call('feishu.ping', {}, { caller: 'test' }), { ok: true })
  } finally {
    store.close()
  }
})

test('unsubscribe：删订阅与游标，返回条数；重复调用为 0；事件史与已有投递不动', async () => {
  const store = openStore(':memory:')
  try {
    const bus = new EventLog(store, { log: silent })
    const seen: string[] = []
    bus.subscribe('p1', 'message.received', (e) => {
      seen.push(e.id)
    })
    // 订阅后、投递前就有事件：卸载必须让它不再被投
    store.insertEvent(ev('e1'))
    assert.equal(store.listSubscriptions().length, 1)

    assert.equal(bus.unsubscribe('p1'), 1)
    assert.equal(store.listSubscriptions().length, 0)
    store.insertEvent(ev('e2'))
    const r = await bus.tick()
    assert.equal(r.delivered, 0)
    assert.deepEqual(seen, [])
    assert.deepEqual(bus.lag(), [])

    // 重复卸载幂等；未订阅过的人返回 0
    assert.equal(bus.unsubscribe('p1'), 0)
    assert.equal(bus.unsubscribe('never'), 0)
    // 事件史保留
    assert.equal(store.countEventLog(), 2)

    // 重新订阅从当前最大 seq 起（旧游标已随订阅行删除）
    const again: string[] = []
    bus.subscribe('p1', 'message.received', (e) => {
      again.push(e.id)
    })
    store.insertEvent(ev('e3'))
    await bus.tick()
    assert.deepEqual(again, ['e3'])
  } finally {
    store.close()
  }
})

test('unsubscribe：同一 subscriber 的多类订阅一次删净', () => {
  const store = openStore(':memory:')
  try {
    const bus = new EventLog(store, { log: silent })
    bus.subscribe('p2', 'message.received', () => {})
    bus.subscribe('p2', 'session.turn.ended', () => {})
    bus.subscribe('keep', 'message.received', () => {})
    assert.equal(bus.unsubscribe('p2'), 2)
    assert.deepEqual(
      store.listSubscriptions().map((s) => s.subscriber),
      ['keep'],
    )
  } finally {
    store.close()
  }
})
