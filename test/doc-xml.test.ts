import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSection, parseBlocks, renderSectionXml } from '../src/domain/doc-xml.ts'

/** 本机 lark-cli 实测形状（docs/006）：标题 `<hN id=…>`、`<hr/>`、`<checkbox done>`、`<p>`。 */
const XML =
  '<h3 id="h1" align="center">✅ 我的待办</h3><hr id="r1"/><checkbox id="c1" done="true">Item 1</checkbox><p id="p1"></p><h3 id="h2">📝 记录</h3><p id="p2">正文</p>'

test('doc-xml：按标签开闭扫描，记录带 id 的块与父子关系', () => {
  const blocks = parseBlocks(XML)
  assert.deepEqual(
    blocks.map((b) => [b.id, b.tag]),
    [
      ['h1', 'h3'],
      ['r1', 'hr'],
      ['c1', 'checkbox'],
      ['p1', 'p'],
      ['h2', 'h3'],
      ['p2', 'p'],
    ],
  )
  for (const b of blocks) {
    assert.equal(b.depth, 0, `${b.id} 应在顶层`)
    assert.equal(b.parentId, undefined, `${b.id} 没有带 id 的父块`)
  }
})

test('doc-xml：自闭合标签不进栈，后面仍是同层兄弟', () => {
  const blocks = parseBlocks('<ul id="u1"><li id="l1">a<br/>b</li></ul><p id="p2">c</p>')
  const l1 = blocks.find((b) => b.id === 'l1')!
  assert.equal(l1.parentId, 'u1')
  assert.equal(l1.depth, 1)
  const p2 = blocks.find((b) => b.id === 'p2')!
  assert.equal(p2.depth, 0)
  assert.equal(p2.parentId, undefined)
})

test('doc-xml：属性里的 `>` 不截断标签，后续块照常解析', () => {
  const blocks = parseBlocks('<p id="p1" title="a > b">x</p><p id="p2">y</p>')
  assert.deepEqual(
    blocks.map((b) => b.id),
    ['p1', 'p2'],
  )
  assert.equal(blocks[1]!.parentId, undefined)
})

test('doc-xml：嵌套 grid/column 里 depth 与父块按最近 id 祖先算', () => {
  const xml =
    '<grid id="g1"><column id="col1"><h3 id="h1">A</h3><p id="p1">x</p></column><column id="col2"><p id="p2">y</p></column></grid>'
  const byId = new Map(parseBlocks(xml).map((b) => [b.id, b]))
  assert.equal(byId.get('col1')!.parentId, 'g1')
  assert.equal(byId.get('col1')!.depth, 1)
  assert.equal(byId.get('h1')!.parentId, 'col1')
  assert.equal(byId.get('h1')!.depth, 2)
  assert.equal(byId.get('p1')!.parentId, 'col1')
  assert.equal(byId.get('p2')!.parentId, 'col2')
})

test('doc-xml：找小节——终点是下一个标题之前的最后一个块', () => {
  assert.deepEqual(findSection(XML, '✅ 我的待办'), { headingId: 'h1', level: 3, endId: 'p1' })
})

test('doc-xml：没有下一个标题时取父节点最后一个块；单块小节终点是自己', () => {
  assert.deepEqual(findSection(XML, '📝 记录'), { headingId: 'h2', level: 3, endId: 'p2' })
  assert.deepEqual(findSection('<h2 id="only">孤节</h2>', '孤节'), {
    headingId: 'only',
    level: 2,
    endId: 'only',
  })
})

test('doc-xml：小节不跨父节点（列内标题取列内最后一块）', () => {
  const xml =
    '<grid id="g1"><column id="col1"><h3 id="h1">A</h3><p id="p1">x</p></column><column id="col2"><p id="p2">y</p></column></grid>'
  assert.deepEqual(findSection(xml, 'A'), { headingId: 'h1', level: 3, endId: 'p1' })
})

test('doc-xml：标题按可见文本匹配（去内联标签与实体），找不到返回 null', () => {
  const xml = '<h3 id="h1">A &amp; <cite id="x">B</cite></h3><p id="p1">x</p>'
  assert.deepEqual(findSection(xml, 'A & B'), { headingId: 'h1', level: 3, endId: 'p1' })
  assert.equal(findSection(xml, 'A & B 之外的标题'), null)
  assert.equal(findSection(XML, ''), null)
})

test('doc-xml：标题按任意 level 截断（h2 也终止 h3 小节）', () => {
  const xml = '<h3 id="a">甲</h3><p id="p1">1</p><h2 id="b">乙</h2><p id="p2">2</p>'
  assert.deepEqual(findSection(xml, '甲'), { headingId: 'a', level: 3, endId: 'p1' })
  assert.deepEqual(findSection(xml, '乙'), { headingId: 'b', level: 2, endId: 'p2' })
})

test('doc-xml：渲染小节——checkbox / 合并 ul / 空段落 / 转义', () => {
  const xml = renderSectionXml(
    '清单',
    '- [x] 完成\n- [ ] 待办\n- 一\n- 二\n\n普通 <段落> & "引号"',
    2,
  )
  assert.equal(
    xml,
    '<h2>清单</h2><checkbox done="true">完成</checkbox><checkbox done="false">待办</checkbox>' +
      '<ul><li>一</li><li>二</li></ul><p></p><p>普通 &lt;段落&gt; &amp; &quot;引号&quot;</p>',
  )
})

test('doc-xml：列表与 checkbox 交替时 ul 成对闭合', () => {
  assert.equal(
    renderSectionXml('T', '- a\n- [ ] b', 3),
    '<h3>T</h3><ul><li>a</li></ul><checkbox done="false">b</checkbox>',
  )
})

test('doc-xml：首尾空行不产出空段落，空正文只有标题', () => {
  assert.equal(renderSectionXml('T', '\n正文\n\n', 3), '<h3>T</h3><p>正文</p>')
  assert.equal(renderSectionXml('T', '', 3), '<h3>T</h3>')
})

test('doc-xml：标题文本同样转义，层级只接受 1..9', () => {
  assert.equal(renderSectionXml('A & B <x>', '', 1), '<h1>A &amp; B &lt;x&gt;</h1>')
  for (const level of [0, 10, 2.5, Number.NaN]) {
    assert.throws(() => renderSectionXml('T', '', level), /标题层级必须是 1\.\.9/)
  }
})
