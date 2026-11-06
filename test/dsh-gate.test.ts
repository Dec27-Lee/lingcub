import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openGate } from '../src/plugin-kit/open-gate.ts'
import * as dshPlugin from '../src/plugins/executor-dsh-v2/index.ts'

test('dsh 执行器：同工作区 60 秒内只起一个任务，第二个请求给明确失败原因', async () => {
  const emitted: { kind: string; payload: { reason?: string } }[] = []
  let started = 0
  let handler: ((e: { payload: unknown }) => Promise<void>) | null = null
  const ctx = {
    config: { binary: 'dsh', allowRoots: ['E:\\Develop_E'], terminal: false, timeoutMs: 1000 },
    log: () => {},
    registerPort: () => {},
    on: (_kind: string, fn: never) => {
      handler = fn
    },
    emit: (kind: string, payload: { reason?: string }) => {
      emitted.push({ kind, payload })
    },
    has: () => true,
    submit: async () => ({ receiptId: 1, status: 'submitted' }),
    call: async () => null,
  }
  dshPlugin.setup(ctx as never)
  const req = (id: string) => ({ payload: { requestId: id, mode: 'headless', work: { executor: 'dsh', workspace: 'E:\\Develop_E\\x' } } })
  await handler?.(req('r1') as never)
  await handler?.(req('r2') as never)
  const gated = emitted.find((x) => x.kind === 'session.open.failed' && /60 秒/.test(x.payload.reason ?? ''))
  assert.ok(gated, '第二个请求要被闸门挡下并说明原因')
  assert.equal(started, 0, '单测里不真的起 dsh（start 会被真 CLI 拦住已由上面用例覆盖）')
})

test('open-gate：闸门键含模式与工作区，第二次立刻被拒', () => {
  const m = new Map<string, number>()
  assert.equal(openGate(m, 'headless|E:\\a', 1000), true)
  assert.equal(openGate(m, 'headless|E:\\a', 2000), false)
  assert.equal(openGate(m, 'terminal|E:\\a', 2000), true)
})
