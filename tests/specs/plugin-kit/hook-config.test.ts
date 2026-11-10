import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOOK_SPECS, HOOK_WAIT_SECONDS, groupHasCommand, hookGroup } from '../../../src/plugin-kit/hook-config.ts'

test('代答类钩子：必须带 matcher 与 1900 秒超时（默认 60 秒会把等人的那一轮掐断）', () => {
  assert.equal(HOOK_WAIT_SECONDS, 1900)
  assert.equal(HOOK_SPECS.ask.matcher, 'AskUserQuestion', 'PreToolUse 不带 matcher 会对每个工具都跑一遍')
  assert.equal(HOOK_SPECS.ask.timeout, 1900)
  assert.match(HOOK_SPECS.permission.matcher, /Bash/, '权限确认只对可能弹框的工具放行')
  assert.equal(HOOK_SPECS.permission.timeout, 1900)
  // 不等人回答的钩子不该占着连接：几十秒就该回来
  assert.ok((HOOK_SPECS.stop.timeout ?? 0) <= 60)
  assert.equal(HOOK_SPECS.notify.matcher?.includes('permission_prompt'), true)
})

test('钩子条目形状：matcher 在组上、timeout 在 hook 上', () => {
  const g = hookGroup('node x hook post ask', HOOK_SPECS.ask) as {
    matcher?: string
    timeout?: number
    hooks: { type: string; command: string; timeout?: number }[]
  }
  assert.equal(g.matcher, 'AskUserQuestion')
  assert.equal(g.timeout, undefined, 'timeout 不能挂在组上，Claude 只读 hook 上的')
  assert.equal(g.hooks[0]?.timeout, 1900)
  assert.equal(g.hooks[0]?.type, 'command')
  // 没有 matcher / timeout 的条目不该写出空字段
  const bare = hookGroup('node x hook post stop') as Record<string, unknown>
  assert.deepEqual(bare, { hooks: [{ type: 'command', command: 'node x hook post stop' }] })
})

test('按命令识别旧条目：改形状时要能把旧的剔掉', () => {
  const old = { hooks: [{ type: 'command', command: 'node x hook post ask' }] }
  assert.equal(groupHasCommand(old, 'node x hook post ask'), true)
  assert.equal(groupHasCommand(old, 'node x hook post stop'), false)
  assert.equal(groupHasCommand(null, 'x'), false)
})
