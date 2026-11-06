import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openGate } from '../src/plugin-kit/open-gate.ts'

test('开窗闸门：同工作区 60 秒内只放一次（防连点开多窗）', () => {
  const recent = new Map<string, number>()
  const t0 = 1_000_000
  assert.equal(openGate(recent, 'terminal|E:\\ws', t0), true)
  assert.equal(openGate(recent, 'terminal|E:\\ws', t0 + 1_000), false, '1 秒后再点不能开第二个')
  assert.equal(openGate(recent, 'terminal|E:\\ws', t0 + 59_999), false)
  assert.equal(openGate(recent, 'terminal|E:\\ws', t0 + 60_000), true, '过了窗口期可以再开')
})

test('开窗闸门：不同工作区、不同模式互不影响', () => {
  const recent = new Map<string, number>()
  const t0 = 1_000_000
  assert.equal(openGate(recent, 'terminal|E:\\a', t0), true)
  assert.equal(openGate(recent, 'terminal|E:\\b', t0), true, '换个工作区照开')
  assert.equal(openGate(recent, 'headless|E:\\a', t0), true, '同目录换模式也算不同请求')
})
