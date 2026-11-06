import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCardAction } from '../src/domain/card-action.ts'
import { mapCardAction } from '../src/plugins/source-feishu-card/index.ts'

const payload = {
  type: 'card.action.trigger',
  event_id: 'ev-1',
  operator_id: 'ou_1',
  message_id: 'om_1',
  chat_id: 'oc_1',
  action_tag: 'button',
  action_value: '{"k":"pick","id":"ws-1"}',
}

test('卡片回调归一：解析按钮值、保留原始字符串', () => {
  const a = parseCardAction(payload)
  assert.ok(a)
  assert.equal(a.id, 'ev-1')
  assert.equal(a.chatId, 'oc_1')
  assert.equal(a.actorId, 'ou_1')
  assert.equal(a.messageId, 'om_1')
  assert.deepEqual(a.action, { k: 'pick', id: 'ws-1' })
  assert.equal(a.rawAction, payload.action_value)
})

test('卡片回调归一：缺 action_value / type / 非法 JSON 都返回 null', () => {
  assert.equal(parseCardAction({ ...payload, action_value: undefined }), null)
  assert.equal(parseCardAction({ ...payload, type: 'im.message.receive_v1' }), null)
  assert.equal(parseCardAction({ ...payload, action_value: '{bad' }), null)
  assert.equal(parseCardAction({ ...payload, action_value: '[1]' }), null)
  assert.equal(parseCardAction(null), null)
})

test('source-feishu-card：Event 仍是旧形状（text 为原始 action_value）', () => {
  const e = mapCardAction(payload, '2026-11-04T00:00:00Z')
  assert.ok(e)
  assert.equal(e.id, 'ev-1')
  assert.equal(e.source, 'source-feishu-card')
  assert.equal(e.text, payload.action_value)
  assert.equal(e.channel.id, 'oc_1')
  assert.equal(e.actor.id, 'ou_1')
  assert.equal(mapCardAction({ ...payload, action_value: '' }, 'x'), null)
})
