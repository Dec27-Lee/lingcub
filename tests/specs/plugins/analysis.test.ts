import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSummaryTask, parseAnalysis, parseSummary } from '../../../src/plugins/capability-ai/index.ts'
import { analysisEventId } from '../../../src/plugins/scenario-analysis/index.ts'

const event = {
  id: 'e1',
  source: 'source-dingtalk',
  externalId: 'm1',
  occurredAt: '2026-11-05T09:00:00.000Z',
  actor: { id: 'u1', name: '李健生' },
  channel: { kind: 'dm', id: 'c1', name: '李健生' },
  text: '这个封号问题怎么处理？',
}

test('AI 摘要任务包含同会话历史与当前消息', () => {
  const task = buildSummaryTask(
    event,
    [
      { id: 'h1', occurredAt: '2026-11-05T08:50:00.000Z', actor: { id: 'me', name: '李鹏跃' }, text: '先观察一下' },
      { id: 'h2', occurredAt: '2026-11-05T08:55:00.000Z', actor: { id: 'u1', name: '李健生' }, text: '好' },
    ],
    '你是分析器。',
  )
  assert.match(task, /你是分析器/)
  assert.match(task, /16:50.*李鹏跃.*先观察一下/)
  assert.match(task, /当前消息/)
  assert.match(task, /这个封号问题怎么处理/)
})

test('AI 摘要解析 JSON、纯文本和长度上限', () => {
  assert.equal(parseSummary('{"summary":"需要确认封号原因"}'), '需要确认封号原因')
  assert.equal(parseSummary('需要确认封号原因'), undefined)
  assert.match(parseSummary('{"summary":"' + '长'.repeat(100) + '"}', 80) ?? '', /…$/)
  assert.equal(parseSummary('{}'), undefined)
})

test('AI 摘要任务：媒体提示不进提示词，模型只看得到占位符', () => {
  const task = buildSummaryTask(
    {
      ...event,
      text: '[图片消息](mediaId=m1) 注意：如需下载使用dws chat message download-media命令下载',
    },
    [
      {
        id: 'h1',
        occurredAt: '2026-11-05T08:50:00.000Z',
        actor: { id: 'u1', name: '李健生' },
        text: '[图片消息](mediaId=m0) 注意：如需下载使用dws chat message download-media命令下载',
      },
    ],
    '你是分析器。',
  )
  assert.equal(task.includes('download-media'), false)
  assert.match(task, /\[图片消息\]\(mediaId=m1\)/)
})

test('AI 分析解析 urgency/entities，并把字段带出去', () => {
  const a = parseAnalysis('{"summary":"需要处理","urgency":"high","entities":["明道云","刘艳"]}')
  assert.deepEqual(a, { summary: '需要处理', urgency: 'high', entities: ['明道云', '刘艳'] })
  assert.equal(parseAnalysis('{"summary":"普通"}', 80)?.urgency, undefined)
})

test('AI 分析解析 points/need/context，并裁掉超长字段', () => {
  const a = parseAnalysis(
    JSON.stringify({
      summary: '支付链路降级，今天只到 80%。',
      points: ['redis 降级 80%', '对账单接口已完成', '长'.repeat(100)],
      need: '确认杭州无感签约是否今天上线',
      context: '在推进：昨天已经开始降级',
      urgency: 'high',
      entities: ['叶三星'],
    }),
  )
  assert.deepEqual(a?.points?.slice(0, 2), ['redis 降级 80%', '对账单接口已完成'])
  assert.ok(a?.points?.[2]?.endsWith('…'), '超长要点要截断')
  assert.equal(a?.need, '确认杭州无感签约是否今天上线')
  assert.equal(a?.context, '在推进：昨天已经开始降级')
})

test('AI 分析任务：把此前几条的分析结论一起给模型', () => {
  const task = buildSummaryTask(event, [], '你是分析器。', [
    { at: '2026-11-05T08:00:00.000Z', summary: '昨天开始降级处理', urgency: 'normal' },
    { at: '2026-11-05T08:40:00.000Z', summary: '对账单接口还没初始化', points: ['等运维放行'] },
  ])
  assert.match(task, /此前几条消息的分析结论/)
  assert.match(task, /\[16:00\] 昨天开始降级处理（normal）/)
  assert.match(task, /对账单接口还没初始化（要点：等运维放行）/)
  // 没有此前分析时不出现这一节，避免给模型空的锚点
  assert.doesNotMatch(buildSummaryTask(event, [], '你是分析器。'), /此前几条消息的分析结论/)
})

test('分析事件 id：首轮稳定，重试生成独立事件', () => {
  assert.equal(analysisEventId('e1', 1), 'analysis:e1')
  assert.equal(analysisEventId('e1', 2), 'analysis:e1:r1')
  assert.equal(analysisEventId('e1', 3), 'analysis:e1:r2')
})
