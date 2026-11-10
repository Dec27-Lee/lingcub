import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claimTodo, mergeTodos, parseTodos, renderTodos, splitTodo } from '../../../src/domain/doc-todos.ts'

test('文档待办：解析与渲染往返', () => {
  const md = '- [ ] [t1] 写登录\n- [x] [t2] 跑测试 [alice]'
  const items = parseTodos(md)
  assert.deepEqual(items, [
    { id: 't1', text: '写登录', done: false },
    { id: 't2', text: '跑测试', done: true, owner: 'alice' },
  ])
  assert.equal(renderTodos(items), md)
  assert.deepEqual(parseTodos('普通段落\n- 不是待办'), [])
})

test('文档待办：认领冲突/已完成/不存在/幂等', () => {
  const items = parseTodos('- [ ] [t1] 写登录 [alice]\n- [x] [t2] 跑测试\n- [ ] [t3] 补文档')
  assert.deepEqual(claimTodo(items, 't1', 'bob').reason, 'taken')
  assert.deepEqual(claimTodo(items, 't2', 'bob').reason, 'done')
  assert.deepEqual(claimTodo(items, 'nope', 'bob').reason, 'missing')
  const ok = claimTodo(items, 't1', 'alice')
  assert.equal(ok.ok, true)
  assert.equal(ok.items.find((t) => t.id === 't1')?.owner, 'alice')
  const fresh = claimTodo(items, 't3', 'bob')
  assert.equal(fresh.ok, true)
  assert.equal(fresh.items.find((t) => t.id === 't3')?.owner, 'bob')
})

test('文档待办：合并保留已有 owner、完成态取或', () => {
  const cur = parseTodos('- [ ] [t1] 旧文本 [alice]\n- [x] [t2] 已完成')
  const inc = parseTodos('- [ ] [t1] 新文本\n- [ ] [t2] 又出现\n- [ ] [t3] 新增')
  const merged = mergeTodos(cur, inc)
  const t1 = merged.find((t) => t.id === 't1')!
  assert.equal(t1.text, '新文本')
  assert.equal(t1.owner, 'alice')
  assert.equal(merged.find((t) => t.id === 't2')?.done, true)
  assert.equal(merged.find((t) => t.id === 't3')?.text, '新增')
})

test('文档待办：拆分按句读、去重、超长硬切', () => {
  assert.deepEqual(splitTodo('写登录；跑测试，补文档。写登录'), ['写登录', '跑测试', '补文档'])
  assert.deepEqual(splitTodo('短句，', 2), ['短句'])
  const long = 'abcdefghijklmnopqrstuvwxy'
  assert.deepEqual(splitTodo(long, 10), ['abcdefghij', 'klmnopqrst', 'uvwxy'])
})
