import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeConfig, editablePaths } from '../src/kernel/config-schema.ts'

const sample = {
  mode: 'auto',
  log: { level: 'info' },
  store: { path: 'data/lingcub.db' },
  contextWindow: 200_000,
  cleanup: { enabled: true, imageTtlDays: 7, mappingTtlDays: 14, questionTtlHours: 2, maxLogBytes: 5242880 },
  sessions: { newTopicPolicy: 'open', choiceTtlMs: 1800000, replyCooldownMs: 2000, cardRefreshMs: 2000 },
  auto_reply: {
    enabled: false,
    pollSeconds: 5,
    cooldownSeconds: 60,
    policies: [{ reply: '继续', triggers: [{ when: 'stopped' }] }],
  },
  channels: { feishu: { defaultChatId: 'oc_1', pinCards: true, binary: 'lark-cli' } },
  classifiers: { llm: { minConfidence: 0.6, binary: 'claude', args: ['-p'] } },
  sources: { 'feishu-im': { enabled: true, plugin: 'source-feishu-im', fields: { threadId: 'thread_id' } } },
  executor_policies: { claude: { plugin: 'executor-claude', binary: 'claude', args: ['--bg'] } },
}

test('配置页字段：从配置本身推出来，不用改代码就能出现新键', () => {
  const fields = describeConfig(sample)
  const paths = fields.map((f) => f.path)
  // 常见项都在
  for (const p of ['mode', 'contextWindow', 'cleanup.imageTtlDays', 'auto_reply.enabled', 'channels.feishu.pinCards']) {
    assert.ok(paths.includes(p), `缺字段 ${p}`)
  }
  // 新加的键（没写中文名）也要出现，只是名字是路径本身
  assert.ok(paths.includes('sessions.cardRefreshMs'))
})

test('配置页字段：执行器参数与命令行不上页面（平台事实，不给改）', () => {
  const paths = describeConfig(sample).map((f) => f.path)
  assert.ok(!paths.some((p) => p.endsWith('.args')), 'args 不该出现')
  assert.ok(!paths.some((p) => p.startsWith('executor_policies.')), '执行器策略不该展开')
  assert.ok(!paths.some((p) => p.includes('replyArgs')), '回复参数不该出现')
})

test('配置页字段：类型与中文名对得上，只读项不算可改', () => {
  const fields = describeConfig(sample)
  const get = (p: string) => fields.find((f) => f.path === p)!
  assert.equal(get('mode').kind, 'select')
  assert.deepEqual(get('mode').options, ['observe', 'suggest', 'auto'])
  assert.equal(get('cleanup.enabled').kind, 'bool')
  assert.equal(get('cleanup.imageTtlDays').kind, 'number')
  assert.equal(get('auto_reply.policies').kind, 'json', '策略是结构化配置，用 JSON 文本框')
  assert.equal(get('store.path').kind, 'readonly')
  assert.equal(get('mode').label, '运行档位')
  assert.ok(!editablePaths(sample).includes('store.path'), '只读项不能出现在可改列表里')
  assert.equal(get('mode').group, '总览')
  assert.equal(get('auto_reply.enabled').group, '自动回复')
})

test('配置页字段：配置里没出现的已知键也补上（默认值被省略时页面照样认得）', () => {
  const sparse = { mode: 'auto' }
  const fields = describeConfig(sparse)
  assert.ok(fields.some((f) => f.path === 'contextWindow'), '已知键要补出来')
})
