import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as result from '../../../src/plugins/scenario-session-result/index.ts'
import type { PluginContextV2 } from '../../../src/domain/plugin-v2.ts'

test('回执正文：保留换行与列表，只做长度保护', () => {
  const text = '改好了：\n1. 分页修了\n2. 加了测试'
  assert.equal(result.buildResultText(text, 200), text, '短文本原样返回，不压成一行')
  const long = 'x'.repeat(300)
  const clipped = result.buildResultText(long, 100)
  assert.ok(clipped.startsWith('x'.repeat(100)), '超长按上限截断')
  assert.match(clipped, /超出 200 字/, '要告诉用户被截了、去哪看全文')
  assert.equal(result.buildResultText('   ', 100), '已完成', '空内容兜底')
})

test('飞书结果回执：发普通消息（不是 80 字卡片），并回到原话题', async () => {
  const handlers = new Map<string, (e: { id: string; payload: unknown }) => Promise<void>>()
  const submitted: { name: string; input: { target?: { chatId?: string; messageId?: string }; text?: string }; opKey: string }[] = []
  const ctx = {
    config: { sources: ['source-feishu-im'], maxChars: 1500 },
    log: () => {},
    has: () => true,
    on: (kind: string, handler: (e: { id: string; payload: unknown }) => Promise<void>) => handlers.set(kind, handler),
    call: async () => ({ id: 's1', chatId: 'oc_1', source: 'source-feishu-im', rootMessageId: 'om_root' }),
    submit: async (name: string, input: never, opKey: string) => {
      submitted.push({ name, input, opKey })
      return { receiptId: 1, duplicate: false, status: 'submitted' as const }
    },
  } as unknown as PluginContextV2

  result.setup(ctx)
  const answer = '我在这个工作区能做的事情，大致分五类：\n1. 代码定位与链路排查\n2. 改代码\n3. 查数据库'
  await handlers.get('session.turn.ended')?.({ id: 'turn-1', payload: { sessionId: 's1', text: answer } })
  assert.equal(submitted.length, 1, '要有回执')
  assert.equal(submitted[0]?.name, 'notify.reply', '走普通消息，不走卡片')
  assert.equal(submitted[0]?.input.text, answer, '答案全文要回来，不能截成一行')
  assert.equal(submitted[0]?.input.target?.chatId, 'oc_1')
  assert.equal(submitted[0]?.input.target?.messageId, 'om_root', '回到原话题')
})
