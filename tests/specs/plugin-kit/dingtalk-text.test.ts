import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripDwsMediaNotice } from '../../../src/plugin-kit/dingtalk-text.ts'

test('媒体提示清洗：图片占位符后的命令提示被去掉', () => {
  const raw = '[图片消息](mediaId=m1) 注意：如需下载使用dws chat message download-media命令下载'
  assert.equal(stripDwsMediaNotice(raw), '[图片消息](mediaId=m1)')
})

test('媒体提示清洗：视频/文件类占位符同样只留占位符', () => {
  const raw = '[文件消息](mediaId=f1) 注意：如需下载使用dws chat message download-media命令下载。'
  assert.equal(stripDwsMediaNotice(raw), '[文件消息](mediaId=f1)')
})

test('媒体提示清洗：普通消息原样返回，不误删正文里的链接', () => {
  const raw = '看这个 https://example.com/a?x=1 还有 [文档](dingtalk://dingtalkclient/x)'
  assert.equal(stripDwsMediaNotice(raw), raw)
  assert.equal(stripDwsMediaNotice(''), '')
})

test('媒体提示清洗：提示和正文混排时保留正文', () => {
  const raw = '图片在这里 注意：如需下载使用dws chat message download-media命令下载 明天再聊'
  assert.equal(stripDwsMediaNotice(raw), '图片在这里 明天再聊')
})
