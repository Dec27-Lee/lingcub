import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractImageKeys, normalizeImageContent, replaceImageMarks } from '../src/kernel/images.ts'

test('纯图消息的 JSON 正文转成统一标记', () => {
  assert.equal(normalizeImageContent('{"image_key":"img_abc"}'), '![Image](img_abc)')
  assert.equal(normalizeImageContent('普通文字'), '普通文字', '不是 JSON 就原样返回')
  assert.equal(normalizeImageContent('{"other":1}'), '{"other":1}', '没有 image_key 也不动')
})

test('一条消息里多张图：两种标记写法都要认，且去重保序', () => {
  const post = '第一张 ![Image](img_a) 第二张 ![截图](img_b) 老写法 [Image: img_a]'
  assert.deepEqual(extractImageKeys(post), ['img_a', 'img_b'], '同一张图出现两次只下一次')
  assert.deepEqual(extractImageKeys('没有图'), [])
  assert.deepEqual(extractImageKeys('{"image_key":"img_c"}'), ['img_c'], '纯图消息也要能抽出来')
})

test('下载完原地替换标记：成功给路径，失败给占位，不丢图也不重复发正文', () => {
  const post = '看图 ![Image](img_a) 和 ![Image](img_b)'
  const out = replaceImageMarks(
    post,
    new Map([
      ['img_a', 'E:\\data\\images\\1.png'],
      ['img_b', undefined],
    ]),
  )
  assert.equal(out, '看图 [图片] E:\\data\\images\\1.png 和 [图片下载失败: img_b]')
})

test('老写法的图也能替换：`[Image: key]` 不是 markdown 图片语法', () => {
  const out = replaceImageMarks('看看 [Image: img_old] 这张', new Map([['img_old', '/tmp/old.png']]))
  assert.equal(out, '看看 [图片] /tmp/old.png 这张')
})

test('同一张图在正文里出现多次，一起换掉', () => {
  const post = '![Image](img_a) 中间 ![另一段说明](img_a)'
  const out = replaceImageMarks(post, new Map([['img_a', '/tmp/a.png']]))
  assert.equal(out, '[图片] /tmp/a.png 中间 [图片] /tmp/a.png')
})
