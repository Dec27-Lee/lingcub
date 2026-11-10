import assert from 'node:assert/strict'
import { test } from 'node:test'

import { explainExit, MISSING_SUBSCRIPTION_CODE, restartDelay } from '../../../src/plugin-kit/restart.ts'

test('订阅没配（code=2）：固定 60 秒一次，别刷屏', () => {
  assert.equal(MISSING_SUBSCRIPTION_CODE, 2)
  assert.equal(restartDelay(2, 1), 60_000)
  assert.equal(restartDelay(2, 99), 60_000, '试多少次都是 60 秒，不会退化成 0')
})

test('普通异常：5 秒起，翻倍，封顶 60 秒', () => {
  assert.equal(restartDelay(1, 1), 5_000)
  assert.equal(restartDelay(1, 2), 10_000)
  assert.equal(restartDelay(1, 3), 20_000)
  assert.equal(restartDelay(1, 4), 40_000)
  assert.equal(restartDelay(1, 5), 60_000, '封顶')
  assert.equal(restartDelay(1, 50), 60_000)
})

test('退出原因讲人话：code=2 直说缺什么订阅', () => {
  assert.match(explainExit(2, '卡片回调'), /没订阅/)
  assert.match(explainExit(2, '卡片回调'), /60 秒/)
  assert.match(explainExit(1, '消息消费'), /异常退出（code=1）/)
  assert.match(explainExit(0, '消息消费'), /正常结束/)
})
