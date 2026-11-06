import assert from 'node:assert/strict'
import { test } from 'node:test'

import { backoffMs, nextFailures, resolveArgs, RESTART_EXIT_CODE } from '../scripts/supervise.mjs'

test('看门狗：不给子命令时默认 run', () => {
  assert.deepEqual(resolveArgs([]), ['run'], '不给子命令＝run，否则子进程跑 doctor 后正常退出，看门狗跟着退')
  assert.deepEqual(resolveArgs(['--dry-run']), ['run'], '只剩 --dry-run 也要补 run')
  assert.deepEqual(resolveArgs(['run']), ['run'], '显式给了就不重复加')
  assert.deepEqual(resolveArgs(['doctor']), ['doctor'], '其它子命令原样透传')
  assert.deepEqual(resolveArgs(['run', '--foo']), ['run', '--foo'], '多余参数不丢')
})

test('看门狗退避：1-4 次 5 秒，5-19 次 30 秒，20 次以上 300 秒', () => {
  assert.equal(backoffMs(0), 0)
  assert.equal(backoffMs(1), 5_000)
  assert.equal(backoffMs(4), 5_000)
  assert.equal(backoffMs(5), 30_000)
  assert.equal(backoffMs(19), 30_000)
  assert.equal(backoffMs(20), 300_000)
  assert.equal(backoffMs(999), 300_000)
})

test('看门狗：主动重启与「活过一阵才崩」都清零，快速崩才累加', () => {
  assert.equal(nextFailures({ code: RESTART_EXIT_CODE, ranMs: 10, failures: 7 }), 0, '重启请求不算失败')
  assert.equal(nextFailures({ code: 0, ranMs: 10, failures: 7 }), 0, '正常结束不累加')
  assert.equal(nextFailures({ code: 1, ranMs: 90_000, failures: 7 }), 0, '活过 60 秒就从零计')
  assert.equal(nextFailures({ code: 1, ranMs: 3_000, failures: 7 }), 8, '快速崩要累加')
})
