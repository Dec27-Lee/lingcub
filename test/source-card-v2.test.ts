import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handlePayload } from '../src/plugins/source-feishu-card-v2/index.ts'

const payload = {
  type: 'card.action.trigger',
  event_id: 'ev-1',
  operator_id: 'ou_1',
  message_id: 'om_1',
  chat_id: 'oc_1',
  action_tag: 'button',
  action_value: '{"k":"ans","qid":"q1","label":"A"}',
}

test('卡片事件源 v2：归一后发 card.action，带稳定 id 与 subject', () => {
  const emitted: { kind: string; payload: unknown; opts: { id: string; subject?: string } }[] = []
  const a = handlePayload(payload, (kind, p, opts) => emitted.push({ kind, payload: p, opts }))
  assert.ok(a)
  assert.deepEqual(a.action, { k: 'ans', qid: 'q1', label: 'A' })
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]!.kind, 'card.action')
  assert.equal(emitted[0]!.opts.id, 'card:ev-1')
  assert.equal(emitted[0]!.opts.subject, 'oc_1')
})

test('卡片事件源 v2：非法载荷不发事件', () => {
  const emitted: unknown[] = []
  assert.equal(handlePayload({ type: 'card.action.trigger' }, (_k, _p, _o) => emitted.push(1)), null)
  assert.equal(handlePayload({ type: 'other', event_id: 'x', chat_id: 'y', action_value: '{}' }, () => emitted.push(1)), null)
  assert.equal(emitted.length, 0)
})
