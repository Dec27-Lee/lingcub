import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDingTalkReport, isDingTalkReport } from '../../../src/plugin-kit/dingtalk-report.ts'

const report = `肖亚伦的工作日志
日期：
2026-11-05
今日工作：
【S26744】【盘锦】蓝卡设备停车场排查
完成进度：100%
工作说明：完成现场主控日志排查，暂无异常原因结论
【D12223】【合生】优化智芯原动摄像机串口波特率设置接口不兼容
完成进度：100%
工

0
0
[dingtalk://dingtalkclient/action/openapp?redirect_url=https%3A%2F%2Fx](dingtalk://dingtalkclient/action/openapp?redirect_url=https%3A%2F%2Fx)
[https://landray.dingtalkapps.com/a](https://landray.dingtalkapps.com/a)
[https://alidocs.dingtalk.com/b](https://alidocs.dingtalk.com/b)`

test('钉钉日报：去掉尾部链接块和空字段噪声', () => {
  assert.equal(isDingTalkReport(report), true)
  const out = formatDingTalkReport(report)
  assert.equal(out.includes('dingtalk://'), false)
  assert.equal(out.includes('landray'), false)
  assert.equal(out.includes('alidocs'), false)
  assert.equal(out.includes('\n0\n0'), false)
  assert.equal(out.startsWith('肖亚伦的工作日志'), true)
  assert.equal(out.includes('日期：2026-11-05'), true)
  assert.equal(out.includes('完成进度：100%'), true)
  assert.equal(out.includes('工作说明：完成现场主控日志排查'), true)
})

test('普通消息保持原文', () => {
  const text = '普通消息\n[查看详情](https://example.com/x)'
  assert.equal(formatDingTalkReport(text), text)
})

test('只有日报链接的消息：只保留标题', () => {
  const text = '[日志]:肖亚伦的工作日志 url: https://landray.dingtalkapps.com/x?a=1'
  assert.equal(formatDingTalkReport(text), '肖亚伦的工作日志')
})
