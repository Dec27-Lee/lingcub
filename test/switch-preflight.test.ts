import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigSchema } from '../src/kernel/config.ts'
import { switchProblems } from '../src/kernel/plugin-v2/preflight.ts'

function cfg(control: Record<string, string>, sources: Record<string, unknown> = {}) {
  return ConfigSchema.parse({ store: { path: ':memory:' }, control, sources })
}

test('切换检查：场景开关与插件配套', () => {
  const scenario = cfg({ status: 'scenario', stop: 'scenario', new: 'scenario', messages: 'bus' })
  assert.match(
    switchProblems(scenario, {}).join('|'),
    /scenario-console 未启用/,
  )
  assert.match(
    switchProblems(scenario, { 'scenario-console': true, 'scenario-dev-dispatch': true }).join('|'),
    /source-feishu-card-v2 未启用/,
  )
  assert.deepEqual(
    switchProblems(scenario, {
      'scenario-console': true,
      'scenario-dev-dispatch': true,
      'source-feishu-card-v2': true,
    }),
    [],
  )
})

test('切换检查：pipeline 档却启用场景会双回', () => {
  const pipeline = cfg({ status: 'pipeline', stop: 'pipeline', new: 'pipeline', messages: 'pipeline' })
  assert.match(switchProblems(pipeline, { 'scenario-console': true }).join('|'), /双回/)
  assert.match(switchProblems(pipeline, { 'scenario-session-post': true }).join('|'), /双派工/)
})

test('切换检查：bus 不支持新话题开窗策略', () => {
  const c = ConfigSchema.parse({
    store: { path: ':memory:' },
    control: { messages: 'bus' },
    sessions: { newTopicPolicy: 'open' },
  })
  assert.match(
    switchProblems(c, {
      'scenario-dev-dispatch': true,
      'source-feishu-card-v2': true,
    }).join('|'),
    /newTopicPolicy=open/,
  )
})

test('切换检查：v1/v2 卡源不能同时开', () => {
  const c = cfg(
    { status: 'scenario', stop: 'scenario', new: 'scenario', messages: 'bus' },
    { 'feishu-card': { plugin: 'source-feishu-card', enabled: true } },
  )
  assert.match(
    switchProblems(c, {
      'scenario-console': true,
      'scenario-dev-dispatch': true,
      'source-feishu-card-v2': true,
    }).join('|'),
    /同源双消费者/,
  )
})
