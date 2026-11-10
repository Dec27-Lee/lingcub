import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Event } from '../../../src/domain/types.ts'
import { buildRelayCard, formatBeijingTime } from '../../../src/plugins/scenario-dingtalk-feishu-relay/index.ts'

function ev(over: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    source: 'source-dingtalk-group',
    externalId: 'm1',
    receivedAt: '2026-11-05T09:00:00.000Z',
    occurredAt: '2026-11-05T09:00:00.000Z',
    actor: { id: 'u1', name: '李健生' },
    channel: { kind: 'group', id: 'cid1', name: '智能体-异常管控' },
    text: '这是正文',
    raw: {},
    ...over,
  }
}

test('钉钉飞书中转卡：正文带来源、发送人、会话和消息内容', () => {
  const card = buildRelayCard(ev())
  const header = (card as { header: { template: string; title: { content: string } } }).header
  assert.equal(header.template, 'green')
  assert.equal(header.title.content, '李健生 · 智能体-异常管控 · 17:00')
  const elements = (card as { elements: { content?: string }[] }).elements
  assert.ok(elements.some((e) => (e.content ?? '').includes('这是正文')))
  assert.ok(!elements.some((e) => (e.content ?? '').includes('来源')))
})

test('钉钉飞书中转卡：UTC 时间统一显示北京时间', () => {
  assert.equal(formatBeijingTime('2026-11-05T09:50:16.000Z'), '2026-11-05 17:50:16')
})

test('钉钉飞书中转卡：私聊蓝色、标题不带群名', () => {
  const card = buildRelayCard(ev({ channel: { kind: 'dm', id: 'c1', name: '易春云' } }))
  const header = (card as { header: { template: string; title: { content: string } } }).header
  assert.equal(header.template, 'blue')
  assert.equal(header.title.content, '李健生 · 17:00')
})

test('钉钉飞书中转卡：有 img_key 的图片变成卡片 img，不把 mediaId 留在正文', () => {
  const card = buildRelayCard(ev({ text: '[图片消息](mediaId=m1)' }), 3000, [
    { mediaId: 'm1', imageKey: 'img_test' },
  ])
  const elements = (card as { elements: { tag: string; content?: string; img_key?: string }[] }).elements
  assert.equal(elements.some((e) => e.tag === 'img' && e.img_key === 'img_test'), true)
  assert.equal(elements.some((e) => (e.content ?? '').includes('mediaId')), false)
})

test('钉钉飞书中转卡：DWS 的下载命令提示不出现在卡片里', () => {
  const text = '[图片消息](mediaId=m1) 注意：如需下载使用dws chat message download-media命令下载'
  const card = buildRelayCard(ev({ text }), 3000, [{ mediaId: 'm1', imageKey: 'img_test' }])
  assert.equal(JSON.stringify(card).includes('download-media'), false)
  const elements = (card as { elements: { tag: string }[] }).elements
  assert.equal(elements.some((e) => e.tag === 'img'), true, '图仍然要发出来')
})

test('钉钉飞书中转卡：图片下载失败只留占位，不带命令提示', () => {
  const text = '[图片消息](mediaId=m1) 注意：如需下载使用dws chat message download-media命令下载'
  const card = buildRelayCard(ev({ text }), 3000, [{ mediaId: 'm1' }])
  const elements = (card as { elements: { content?: string }[] }).elements
  assert.equal(elements[0]?.content, '📷 图片（暂不能预览）')
  assert.equal(JSON.stringify(card).includes('download-media'), false)
})

test('钉钉飞书中转卡：正文后接灰底色块总结，不带图标和标签', () => {
  const card = buildRelayCard(ev(), 3000, [], '对方在确认异常管控的处理方式')
  const elements = (card as { elements: { content?: string }[] }).elements
  assert.match(elements[0]?.content ?? '', /这是正文/)
  assert.equal((elements[1] as { tag?: string }).tag, 'column_set')
  const block = elements[1] as {
    background_style?: string
    columns: { elements: { content?: string }[] }[]
  }
  assert.equal(block.background_style, 'grey')
  assert.equal(block.columns[0]?.elements[0]?.content, '对方在确认异常管控的处理方式')
  assert.doesNotMatch(JSON.stringify(block), /🤖|AI 总结/)
})

test('钉钉飞书中转卡：自己发出的消息显示“我”', () => {
  const card = buildRelayCard(ev({ source: 'source-dingtalk-sent', actor: { id: 'me', name: '李鹏跃' } }))
  const header = (card as { header: { title: { content: string } } }).header
  assert.equal(header.title.content, '我 · 智能体-异常管控 · 17:00')
})
