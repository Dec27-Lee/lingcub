import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderWebhookCard, signFeishuWebhook } from '../src/plugins/channel-feishu-webhook/index.ts'

test('飞书 webhook：notice 卡转为 interactive 卡，保留标题/时间/正文', () => {
  const card = renderWebhookCard({
    kind: 'notice',
    title: '钉钉消息 · 易春云',
    time: '2026-11-05T09:00:00.000Z',
    body: '**来源**：钉钉群消息\n**发送人**：易春云\n正文',
  }) as { header: { title: { content: string } }; elements: { content?: string }[] }
  assert.equal(card.header.title.content, '钉钉消息 · 易春云')
  assert.ok(card.elements.some((e) => (e.content ?? '').includes('钉钉群消息')))
  assert.ok(card.elements.some((e) => (e.content ?? '').includes('易春云')))
})

test('飞书 webhook：签名用 timestamp\\nsecret 作为 HMAC key', () => {
  const a = signFeishuWebhook(1793860000, 'secret')
  const b = signFeishuWebhook(1793860000, 'secret')
  const c = signFeishuWebhook(1793860001, 'secret')
  assert.equal(a, b)
  assert.notEqual(a, c)
})
