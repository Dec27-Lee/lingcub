import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Action } from '../src/domain/types.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { openStore } from '../src/kernel/store.ts'

const reply: Action = { kind: 'reply_only', text: '收到' }

test('同一 dedupeKey 只投递一次', async () => {
  const store = openStore(':memory:')
  try {
    const sent: string[] = []
    const outbox = new Outbox(store, async (_a, key) => {
      sent.push(key)
    })

    assert.equal(outbox.enqueue(reply, 'k1'), 'enqueued')
    assert.equal(outbox.enqueue(reply, 'k1'), 'duplicate')
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.deepEqual(sent, ['k1'])

    // 再 tick 一次：已 done 的不再投递
    assert.deepEqual(await outbox.tick(), { done: 0, failed: 0, dead: 0 })
    assert.deepEqual(sent, ['k1'])
    assert.equal(store.countOutbox('done'), 1)
  } finally {
    store.close()
  }
})

test('投递失败：前两次回 pending 重试，第三次转 dead 并告警', async () => {
  const store = openStore(':memory:')
  try {
    const events: string[] = []
    const outbox = new Outbox(
      store,
      async () => {
        throw new Error('网络断了')
      },
      { maxAttempts: 3, log: (level, msg) => events.push(`${level}:${msg}`) },
    )
    outbox.enqueue(reply, 'k1')

    assert.deepEqual(await outbox.tick(), { done: 0, failed: 1, dead: 0 })
    assert.equal(store.countOutbox('pending'), 1)
    assert.deepEqual(await outbox.tick(), { done: 0, failed: 1, dead: 0 })
    assert.deepEqual(await outbox.tick(), { done: 0, failed: 0, dead: 1 })
    assert.equal(store.countOutbox('dead'), 1)

    // dead 之后不再重试
    assert.deepEqual(await outbox.tick(), { done: 0, failed: 0, dead: 0 })
    assert.ok(events.some((m) => m.startsWith('error:') && m.includes('死信')))
  } finally {
    store.close()
  }
})

test('单条失败不影响同批次其他条目', async () => {
  const store = openStore(':memory:')
  try {
    const outbox = new Outbox(store, async (a) => {
      if (a.kind === 'reply_only' && a.text === '坏') throw new Error('坏消息')
    })
    outbox.enqueue({ kind: 'reply_only', text: '坏' }, 'k1')
    outbox.enqueue({ kind: 'reply_only', text: '好' }, 'k2')
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 1, dead: 0 })
    assert.equal(store.countOutbox('done'), 1)
    assert.equal(store.countOutbox('pending'), 1)
  } finally {
    store.close()
  }
})

test('崩溃恢复：dispatched 未完成转 unknown，不自动重投', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lingcub-outbox-')), 'lingcub.db')
  const first = openStore(path)
  first.enqueue(reply, 'k1')
  const [row] = first.pendingOutbox(10)
  assert.ok(row)
  first.markOutbox(row.id, 'dispatched', 1) // 投递到一半进程挂了
  first.close()

  const reopened = openStore(path)
  try {
    // 崩溃恢复不在构造函数里跑：多个进程同时开库时不能各自重投一遍
    assert.equal(reopened.countOutbox('dispatched'), 1)
    assert.equal(reopened.recoverOutbox(), 1)
    assert.equal(reopened.countOutbox('unknown'), 1)
    assert.equal(reopened.countOutbox('pending'), 0)
    assert.equal(reopened.countOutbox('dispatched'), 0)
    // unknown 留在库里等人工对账，不会再被 tick 取走
    assert.deepEqual(reopened.pendingOutbox(10), [])
  } finally {
    reopened.close()
  }
})
