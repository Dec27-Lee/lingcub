import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSummaryTask, parseAnalysis, parseSummary } from '../src/plugins/capability-ai/index.ts'
import { analysisEventId } from '../src/plugins/scenario-analysis/index.ts'

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

test('分析事件 id：首轮稳定，重试生成独立事件', () => {
  assert.equal(analysisEventId('e1', 1), 'analysis:e1')
  assert.equal(analysisEventId('e1', 2), 'analysis:e1:r1')
  assert.equal(analysisEventId('e1', 3), 'analysis:e1:r2')
})
