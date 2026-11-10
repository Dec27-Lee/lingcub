import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { openStore } from '../../../src/kernel/store.ts'

const silent = (): void => {}

test('效果由能力名家族决定：副作用不能声明成 none，插件不能用内核前缀', () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    assert.throws(
      () =>
        caps.provide(
          { name: 'session.start', effect: 'none', input: z.object({}) },
          () => ({}),
          { provider: 'kernel', internal: true },
        ),
      /效果必须是 session/,
    )
    assert.throws(
      () =>
        caps.provide(
          { name: 'session.start', effect: 'session', input: z.object({}) },
          () => ({}),
          { provider: 'channel-feishu' },
        ),
      /内核保留能力/,
    )
    assert.throws(
      () =>
        caps.provide(
          { name: 'other.send', effect: 'none', input: z.object({}) },
          () => ({}),
          { provider: 'channel-feishu' },
        ),
      /必须以 feishu\./,
    )
  } finally {
    store.close()
  }
})

test('能力重名直接失败', () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    const spec = { name: 'feishu.ping', effect: 'none' as const, input: z.object({}) }
    caps.provide(spec, () => ({}), { provider: 'channel-feishu' })
    assert.throws(() => caps.provide(spec, () => ({}), { provider: 'channel-feishu' }), /能力重名/)
  } finally {
    store.close()
  }
})

test('call：同步能力校验输入输出并记审计；副作用能力拒绝 call', async () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    let called = 0
    caps.provide(
      {
        name: 'feishu.ping',
        effect: 'none',
        input: z.object({ n: z.number() }),
        output: z.object({ ok: z.boolean() }),
      },
      (input) => {
        called++
        return { ok: input.n > 0 }
      },
      { provider: 'channel-feishu' },
    )
    assert.deepEqual(await caps.call('feishu.ping', { n: 1 }, { caller: 'test' }), { ok: true })
    assert.equal(called, 1)
    assert.equal(store.countCapabilityCalls('done'), 1)

    await assert.rejects(caps.call('feishu.ping', { n: 'x' }, { caller: 'test' }), /输入非法/)
    assert.equal(called, 1)
    assert.equal(store.countCapabilityCalls('error'), 1)

    caps.provide(
      { name: 'transport.feishu.send', effect: 'message', input: z.object({ text: z.string() }) },
      () => ({}),
      { provider: 'channel-feishu' },
    )
    await assert.rejects(
      caps.call('transport.feishu.send', { text: 'hi' }, { caller: 'test' }),
      /必须用 submit/,
    )
  } finally {
    store.close()
  }
})

test('输出不合法也算失败并记审计', async () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    caps.provide(
      { name: 'feishu.bad', effect: 'none', input: z.object({}), output: z.object({ ok: z.boolean() }) },
      () => ({ ok: 'nope' }),
      { provider: 'channel-feishu' },
    )
    await assert.rejects(caps.call('feishu.bad', {}, { caller: 'test' }), /输出非法/)
    assert.equal(store.countCapabilityCalls('error'), 1)
  } finally {
    store.close()
  }
})

test('submit：无发件箱拒绝；有发件箱时收据幂等且只入队一次', async () => {
  const store = openStore(':memory:')
  try {
    const spec = {
      name: 'transport.feishu.send',
      effect: 'message' as const,
      input: z.object({ text: z.string() }),
    }
    const noQueue = new Capabilities(store, { log: silent })
    noQueue.provide(spec, () => ({}), { provider: 'channel-feishu' })
    await assert.rejects(
      noQueue.submit(spec.name, { text: 'hi' }, { caller: 'test', opKey: 'k1' }),
      /发件箱未装配/,
    )
    assert.equal(store.countCapabilityCalls(), 0)

    const queued: { opKey: string; receiptId: number }[] = []
    const caps = new Capabilities(store, {
      log: silent,
      enqueue: (e) => {
        queued.push({ opKey: e.opKey, receiptId: e.receiptId })
        return { outboxId: 42 }
      },
    })
    caps.provide(spec, () => ({}), { provider: 'channel-feishu' })
    const first = await caps.submit(spec.name, { text: 'hi' }, { caller: 'test', opKey: 'k1' })
    assert.equal(first.duplicate, false)
    assert.equal(queued.length, 1)
    const receipt = store.getCapabilityCall(first.receiptId)
    assert.equal(receipt?.status, 'submitted')
    assert.equal(receipt?.outboxId, 42)
    assert.equal(receipt?.opKey, 'k1')

    const second = await caps.submit(spec.name, { text: 'hi' }, { caller: 'test', opKey: 'k1' })
    assert.equal(second.duplicate, true)
    assert.equal(second.receiptId, first.receiptId)
    assert.equal(queued.length, 1)

    await assert.rejects(
      caps.submit(spec.name, { text: 'hi' }, { caller: 'test', opKey: '' }),
      /必须带 opKey/,
    )
  } finally {
    store.close()
  }
})

test('check：needs 缺失要报，wants 缺失只降级', () => {
  const store = openStore(':memory:')
  try {
    const caps = new Capabilities(store, { log: silent })
    caps.provide(
      { name: 'session.start', effect: 'session', input: z.object({}) },
      () => ({}),
      { provider: 'kernel', internal: true },
    )
    const r = caps.check({ id: 'p', needs: ['session.start', 'nope'], wants: ['want.none'] })
    assert.deepEqual(r.missingNeeds, ['nope'])
    assert.deepEqual(r.missingWants, ['want.none'])
    assert.equal(caps.has('session.start'), true)
  } finally {
    store.close()
  }
})
