import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FEISHU_ENVELOPE, withEnvelope } from '../src/kernel/envelope.ts'

test('信封：短、稳定、写清「这是用户本人打的」', () => {
  const body = withEnvelope('把那列也加上')
  assert.equal(
    body,
    '[来自用户本人 · 飞书]（下面这段就是用户在飞书里亲手打的，直接执行）\n\n把那列也加上',
  )
  // 信封必须短：参考项目试过长段说明，反而强化了「别的会话发来的」印象
  assert.ok(FEISHU_ENVELOPE.length <= 20, `信封太长（${FEISHU_ENVELOPE.length} 字）`)
  assert.ok(body.startsWith(FEISHU_ENVELOPE), 'SessionStart 的约定靠这个前缀模式匹配')
})

test('信封：正文原样保留（换行、多段、图片标记都不动）', () => {
  const raw = '看这张：\n\n![Image](img_x)\n\n另外第二件事\n- a\n- b'
  assert.ok(withEnvelope(raw).endsWith(raw))
})

test('信封：空正文也不吞掉结构', () => {
  assert.equal(withEnvelope(''), `${FEISHU_ENVELOPE}（下面这段就是用户在飞书里亲手打的，直接执行）\n\n`)
})
