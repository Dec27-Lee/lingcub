import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFeishuHistory } from '../../../src/plugin-kit/feishu-history.ts'

const payload = {
  data: {
    messages: [
      {
        message_id: 'om_new',
        create_time: '2026-11-05 19:02',
        body: { content: '{"text":"后来的"}', text: '后来的' },
        sender: { open_id: 'ou_b', name: '李健生' },
      },
      {
        message_id: 'om_old',
        create_time: '2026-11-05 19:00',
        body: { content: '{"text":"先发的"}' },
        sender: { id: 'ou_a', name: '李鹏跃' },
      },
      { message_id: 'om_card', create_time: '2026-11-05 19:01', body: null, sender: { open_id: 'ou_bot' } },
    ],
  },
}

test('飞书历史解析：取正文、按时间升序、排除卡片空消息', () => {
  const rows = parseFeishuHistory(payload, '2026-11-05T11:03:00.000Z')
  assert.deepEqual(
    rows.map((x) => x.externalId),
    ['om_old', 'om_new'],
  )
  assert.equal(rows[0]?.text, '先发的')
  assert.equal(rows[0]?.actor.id, 'ou_a')
  assert.equal(rows[1]?.occurredAt, '2026-11-05T11:02:00.000Z')
})

test('飞书历史解析：before 之后的消息不进入上下文', () => {
  const rows = parseFeishuHistory(payload, '2026-11-05T11:01:00.000Z')
  assert.deepEqual(rows.map((x) => x.externalId), ['om_old'])
})
