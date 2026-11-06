import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideDistribution, type DistributionRule } from '../src/plugins/scenario-distribution/index.ts'

const rules: DistributionRule[] = [
  {
    id: 'urgent-group',
    when: { channelKinds: ['group'], urgency: ['high'] },
    targets: ['feishu-card', 'dispatch'],
  },
  {
    id: 'dingtalk-all',
    when: { sources: ['source-dingtalk', 'source-dingtalk-group'] },
    targets: ['feishu-card'],
  },
]

test('分发决策：先匹配高优先级规则，返回多出口', () => {
  assert.deepEqual(decideDistribution(rules, { source: 'source-dingtalk-group', channelKind: 'group', urgency: 'high' }), {
    ruleId: 'urgent-group',
    targets: ['feishu-card', 'dispatch'],
  })
})

test('分发决策：来源规则命中，规则顺序决定结果', () => {
  assert.deepEqual(decideDistribution(rules, { source: 'source-dingtalk', channelKind: 'dm' }), {
    ruleId: 'dingtalk-all',
    targets: ['feishu-card'],
  })
})

test('分发决策：没有规则命中时 targets 为空，不猜默认出口', () => {
  assert.deepEqual(decideDistribution(rules, { source: 'source-feishu-im', channelKind: 'dm' }), { targets: [] })
})
