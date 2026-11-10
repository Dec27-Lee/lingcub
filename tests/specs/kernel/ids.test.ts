import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dedupeKey, eventId, workId } from '../../../src/kernel/ids.ts'

test('eventId 对同一输入稳定（幂等的基础）', () => {
  assert.equal(eventId('dingtalk-im', 'msg-1'), eventId('dingtalk-im', 'msg-1'))
})

test('不同 source 的同名 externalId 不碰撞', () => {
  assert.notEqual(eventId('dingtalk-im', 'msg-1'), eventId('feishu-im', 'msg-1'))
})

test('分隔符不可伪造：拼接歧义不产生同 id', () => {
  assert.notEqual(eventId('a\u0000b', 'c'), eventId('a', 'b\u0000c'))
})

test('id 定长 16', () => {
  assert.equal(eventId('x', 'y').length, 16)
})

test('workId 与 dedupeKey 域分离', () => {
  assert.notEqual(workId('e1', 1), workId('e1', 2))
  assert.notEqual(dedupeKey('w1', 'start'), dedupeKey('w1', 'stop'))
})
