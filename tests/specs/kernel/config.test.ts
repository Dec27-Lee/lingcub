import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertAllowedRoot, loadProjects } from '../../../src/kernel/config.ts'

const ws = (id: string, root: string) => `
workspaces:
  - id: ${id}
    name: t
    kind: repo
    root: '${root}'
    executor: dsh
    isolation: worktree
`

test('allowRoots 命中：子目录通过', () => {
  assert.doesNotThrow(() => assertAllowedRoot('E:\\Develop_E\\tt\\repo', ['E:\\Develop_E\\tt']))
})

test('allowRoots 未命中：拒绝', () => {
  assert.throws(
    () => assertAllowedRoot('E:\\Other\\repo', ['E:\\Develop_E\\tt']),
    /不在允许根内/,
  )
})

test('前缀不能靠字符串包含绕过：E:\\Develop_E\\ttx 不在 E:\\Develop_E\\tt 内', () => {
  assert.throws(() => assertAllowedRoot('E:\\Develop_E\\ttx', ['E:\\Develop_E\\tt']), /不在允许根内/)
})

test('allowRoots 为空时一律拒绝（fail-closed）', () => {
  assert.throws(() => assertAllowedRoot('E:\\Develop_E', []), /不在允许根内/)
})

test('workspace id 重复时报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-'))
  const f = join(dir, 'projects.yaml')
  writeFileSync(f, ws('dup', 'E:\\a') + '  - id: dup\n    name: t2\n    kind: repo\n    root: \'E:\\b\'\n    executor: dsh\n    isolation: worktree\n')
  assert.throws(() => loadProjects(f), /workspace id 重复/)
})
