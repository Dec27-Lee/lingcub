import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SAID_FULL_MAX, SAID_INLINE_MAX, buildNoticeCard } from '../src/kernel/notice-card.ts'
import { renderNoticeCard } from '../src/plugins/channel-feishu/card.ts'

type El = { tag?: string; content?: string; header?: { title?: { content?: string } }; elements?: { content?: string }[] }

function texts(card: unknown): string[] {
  const body = (card as { body?: { elements?: El[] } }).body
  return (body?.elements ?? []).map((e) => e.content ?? '')
}

test('通知卡：📁/🕐/📦 各占一个元素（挤在一个里会被飞书折成一段）', () => {
  const data = buildNoticeCard({
    title: '修订单分页',
    cwd: 'E:\\w',
    time: '18:33:22',
    stats: '███░ 84% 420k',
    body: '改好了',
  })
  const card = renderNoticeCard(data as never)
  const lines = texts(card)
  assert.ok(lines.includes('📁 `E:\\w`'), '目录单独一行')
  assert.ok(lines.includes('🕐 18:33:22'), '时间单独一行')
  assert.ok(lines.includes('📦 ███░ 84% 420k'), '用量单独一行')
  assert.deepEqual(lines.slice(-1), ['改好了'], '正文在最后')
  const header = (card as { header?: { title?: { content?: string }; template?: string } }).header
  assert.equal(header?.title?.content, '修订单分页', '标题取窗口名')
  assert.equal(header?.template, 'green')
})

test('通知卡：「你在终端里说」短的摆出来，长的折起来，截断要说清原文多少字', () => {
  const short = renderNoticeCard(buildNoticeCard({ title: 't', time: '1:00:00', userSaid: '跑一下测试', body: '好' }) as never)
  const shortTexts = texts(short)
  assert.ok(shortTexts.some((t) => t.includes('你在终端里说')))
  assert.ok(shortTexts.some((t) => t.includes('│ 跑一下测试')), '短内容做成引用块观感')

  const longSaid = '长'.repeat(200)
  const long = renderNoticeCard(buildNoticeCard({ title: 't', time: '1:00:00', userSaid: longSaid, body: '好' }) as never)
  const panel = ((long as { body?: { elements?: El[] } }).body?.elements ?? []).find(
    (e) => e.tag === 'collapsible_panel',
  )
  assert.ok(panel, '长内容要用折叠面板')
  assert.match(panel?.header?.title?.content ?? '', /共 200 字/)

  const huge = 'x'.repeat(SAID_FULL_MAX + 100)
  const clippedCard = renderNoticeCard(buildNoticeCard({ title: 't', time: '1:00:00', userSaid: huge, body: '好' }) as never)
  const panel2 = ((clippedCard as { body?: { elements?: El[] } }).body?.elements ?? []).find(
    (e) => e.tag === 'collapsible_panel',
  )
  assert.match(panel2?.elements?.[0]?.content ?? '', /此处截断/)
})

test('通知卡：分段时后续段标题带 (i/总)，且不再重复头三行', () => {
  const card = buildNoticeCard({ title: '长任务', cwd: 'E:\\w', time: '1:00:00', stats: 's', body: '第二段', index: 2, total: 3 })
  const rendered = renderNoticeCard(card as never)
  assert.equal((rendered as { header?: { title?: { content?: string } } }).header?.title?.content, '长任务 (2/3)')
  const lines = texts(rendered)
  assert.ok(!lines.some((t) => t.startsWith('📁')), '后续段不重复目录')
  assert.deepEqual(lines, ['第二段'], '只留正文')
})

test('通知卡：短句阈值就是 180（多一个字就折叠）', () => {
  const at = 'a'.repeat(SAID_INLINE_MAX)
  const inline = renderNoticeCard(buildNoticeCard({ title: 't', time: '1:00:00', userSaid: at, body: 'b' }) as never)
  assert.ok(!JSON.stringify(inline).includes('collapsible_panel'), '正好 180 字仍然直接显示')
  const over = renderNoticeCard(
    buildNoticeCard({ title: 't', time: '1:00:00', userSaid: `${at}a`, body: 'b' }) as never,
  )
  assert.match(JSON.stringify(over), /collapsible_panel/, '超过 180 字折叠')
})
