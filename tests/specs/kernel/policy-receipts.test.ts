import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema } from '../../../src/kernel/config.ts'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createGate } from '../../../src/kernel/policy.ts'
import { createReceiptSettler } from '../../../src/kernel/receipts.ts'
import { openStore } from '../../../src/kernel/store.ts'

const silent = (): void => {}
const input = { target: { channel: 'feishu', chatId: 'oc_1' }, text: '收到，已处理' }

function setup(mode: 'observe' | 'suggest' | 'auto', deliver?: () => Promise<{ externalId?: string }>) {
  const store = openStore(':memory:')
  const config = ConfigSchema.parse({ store: { path: ':memory:' }, mode })
  const eventLog = new EventLog(store, { log: silent })
  const outbox = new Outbox(store, deliver ?? (async () => ({ externalId: 'om_sent' })), {
    log: silent,
    maxAttempts: 1,
    onSettled: createReceiptSettler(store, eventLog, silent),
  })
  const capabilities = new Capabilities(store, {
    log: silent,
    gate: createGate({ config, store, log: silent }),
    enqueue: (e) => {
      const p = e.payload as { target: { chatId: string }; text: string }
      outbox.enqueue({ kind: 'reply_only', chatId: p.target.chatId, text: p.text }, e.opKey)
      const id = store.outboxIdByDedupeKey(e.opKey)
      return id === null ? undefined : { outboxId: id }
    },
  })
  capabilities.provide(
    {
      name: 'notify.reply',
      effect: 'message',
      input: z.object({ target: z.object({ channel: z.string(), chatId: z.string() }), text: z.string() }),
    },
    () => {
      throw new Error('提交型能力不该被同步调用')
    },
    { provider: 'kernel', internal: true },
  )
  return { store, eventLog, outbox, capabilities, config }
}

test('auto：提交入发件箱，投递成功回填收据并追加 effect.done', async () => {
  const s = setup('auto')
  try {
    const r = await s.capabilities.submit('notify.reply', input, { caller: 'scenario-x', opKey: 'op1' })
    assert.equal(r.status, 'submitted')
    assert.equal(s.store.countOutbox('pending'), 1)
    assert.equal(s.store.countOutbox('done'), 0)

    const ticked = await s.outbox.tick()
    assert.equal(ticked.done, 1)
    const call = s.store.findCapabilityCallByOpKey('op1')
    assert.ok(call)
    assert.equal(call.status, 'done')
    assert.match(call.resultHead ?? '', /om_sent/)

    const events = s.store.eventLogAfter('effect.done', 0, 10)
    assert.equal(events.length, 1)
    assert.equal((events[0].payload as { externalId?: string }).externalId, 'om_sent')
    assert.equal(events[0].subject, `receipt:${call.id}`)
  } finally {
    s.store.close()
  }
})

test('同一 opKey 重复提交：返回同一收据，不重复入队', async () => {
  const s = setup('auto')
  try {
    const a = await s.capabilities.submit('notify.reply', input, { caller: 'scenario-x', opKey: 'op1' })
    const b = await s.capabilities.submit('notify.reply', input, { caller: 'scenario-x', opKey: 'op1' })
    assert.equal(a.receiptId, b.receiptId)
    assert.equal(b.duplicate, true)
    assert.equal(s.store.countOutbox('pending'), 1)
  } finally {
    s.store.close()
  }
})

test('observe：只记 would-do，不发消息', async () => {
  const s = setup('observe')
  try {
    const r = await s.capabilities.submit('notify.reply', input, { caller: 'scenario-x', opKey: 'op-observe' })
    assert.equal(r.status, 'would-do')
    assert.equal(s.store.countOutbox('pending'), 0)
    assert.equal(s.store.countOutbox('done'), 0)
    assert.equal(s.store.findCapabilityCallByOpKey('op-observe')?.status, 'would-do')
  } finally {
    s.store.close()
  }
})

test('suggest：通知类直接放行，不落确认', async () => {
  const s = setup('suggest')
  try {
    const r = await s.capabilities.submit('notify.reply', input, { caller: 'scenario-x', opKey: 'op-suggest' })
    assert.equal(r.status, 'submitted')
    assert.equal(s.store.countOutbox('pending'), 1)
    assert.equal(s.store.listConfirmations('pending').length, 0)
  } finally {
    s.store.close()
  }
})

test('suggest：业务副作用仍停在 pending', async () => {
  const s = setup('suggest')
  try {
    s.capabilities.provide(
      {
        name: 'task.open',
        effect: 'task',
        input: z.object({ text: z.string() }),
      },
      () => {
        throw new Error('提交型能力不该被同步调用')
      },
      { provider: 'kernel', internal: true },
    )
    const r = await s.capabilities.submit('task.open', { text: 'x' }, { caller: 'scenario-x', opKey: 'op-task' })
    assert.equal(r.status, 'pending')
    assert.equal(s.store.countOutbox('pending'), 0)
    assert.equal(s.store.listConfirmations('pending').length, 1)
  } finally {
    s.store.close()
  }
})

test('投递死信：收据转 failed 并追加 effect.failed', async () => {
  const s = setup('auto', async () => {
    throw new Error('飞书 500')
  })
  try {
    const r = await s.capabilities.submit('notify.reply', input, { caller: 'scenario-x', opKey: 'op-dead' })
    const ticked = await s.outbox.tick()
    assert.equal(ticked.dead, 1)
    const call = s.store.findCapabilityCallByOpKey('op-dead')
    assert.ok(call)
    assert.equal(call.id, r.receiptId)
    assert.equal(call.status, 'failed')
    assert.match(call.error ?? '', /飞书 500/)
    const events = s.store.eventLogAfter('effect.failed', 0, 10)
    assert.equal(events.length, 1)
    assert.match(String((events[0].payload as { error?: string }).error), /飞书 500/)
  } finally {
    s.store.close()
  }
})

test('suggest：业务副作用仍落确认并回调 confirmation.requested', () => {
  const store = openStore(':memory:')
  try {
    const config = ConfigSchema.parse({ store: { path: ':memory:' }, mode: 'suggest' })
    const got: { receiptId: number; id: number }[] = []
    const gate = createGate({
      config,
      store,
      log: silent,
      onPending: (req, id) => got.push({ receiptId: req.receiptId, id }),
    })
    const decision = gate({
      name: 'task.open',
      effect: 'task',
      caller: 'scenario-x',
      input: { text: 'x' },
      opKey: 'k1',
      receiptId: 7,
    })
    assert.equal(decision, 'pending')
    assert.equal(got.length, 1)
    assert.equal(got[0]?.receiptId, 7)
    assert.equal(store.listConfirmations()[0]?.id, got[0]?.id)
  } finally {
    store.close()
  }
})
