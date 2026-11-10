import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { ensureTrusted, trustKey, trustStatus } from '../../../src/plugin-kit/claude-trust.ts'

function cfgFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-trust-'))
  const p = join(dir, '.claude.json')
  writeFileSync(p, JSON.stringify(content), 'utf8')
  return p
}

const WS = 'E:\\Develop_E\\lingcub'

test('信任预置：把工作区标记成已信任，其它字段一字不动', () => {
  const file = cfgFile({ numStartups: 3, projects: { 'E:\\other': { hasTrustDialogAccepted: true, lastCost: 1 } } })
  assert.equal(ensureTrusted(WS, { path: file }), true)
  const j = JSON.parse(readFileSync(file, 'utf8')) as { numStartups: number; projects: Record<string, Record<string, unknown>> }
  assert.equal(j.numStartups, 3, '顶层其它字段要保留')
  assert.deepEqual(j.projects['E:\\other'], { hasTrustDialogAccepted: true, lastCost: 1 }, '别人的项目条目不能动')
  assert.equal(j.projects[trustKey(WS)]?.['hasTrustDialogAccepted'], true)
})

test('信任预置：已经信任过就不写文件（幂等，不制造备份噪音）', () => {
  const file = cfgFile({ projects: { [WS]: { hasTrustDialogAccepted: true } } })
  assert.equal(ensureTrusted(WS, { path: file }), false)
})

test('信任预置：大小写不同也认同一个目录，不新建重复条目', () => {
  const file = cfgFile({ projects: { 'e:\\develop_e\\lingcub': { lastCost: 2 } } })
  assert.equal(ensureTrusted('E:\\Develop_E\\Lingcub', { path: file }), true)
  const j = JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, Record<string, unknown>> }
  assert.deepEqual(Object.keys(j.projects), ['e:\\develop_e\\lingcub'], '不能多出一条')
  assert.equal(j.projects['e:\\develop_e\\lingcub']?.['hasTrustDialogAccepted'], true)
  assert.equal(j.projects['e:\\develop_e\\lingcub']?.['lastCost'], 2, '原字段保留')
})

test('信任预置：配置文件不存在或坏了就抛错，不瞎写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-trust-'))
  assert.throws(() => ensureTrusted(WS, { path: join(dir, 'nope.json') }), /找不到 Claude Code 配置/)
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{not json', 'utf8')
  assert.throws(() => ensureTrusted(WS, { path: bad }), /解析/)
  assert.equal(resolve(bad).startsWith(resolve(dir)), true)
})
test('信任判定：未登记的 git 仓库要人工确认一次；登记后不用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-status-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const file = join(dir, '.claude.json')
  writeFileSync(file, JSON.stringify({ projects: {} }), 'utf8')
  const before = trustStatus(repo, { path: file })
  assert.equal(before.trusted, false)
  assert.equal(before.key, repo, '判定用仓库根那条记录')
  // 登记仓库根后，子目录也算已信任
  assert.equal(ensureTrusted(repo, { path: file }), true)
  const sub = join(repo, 'workspace', 'x')
  mkdirSync(sub, { recursive: true })
  assert.equal(trustStatus(sub, { path: file }).trusted, true, 'git 根信任对子目录生效')
})

test('信任判定：纯文件夹不弹确认；带 .mcp.json / .claude 设置才弹', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-status-'))
  const file = join(dir, '.claude.json')
  writeFileSync(file, JSON.stringify({ projects: {} }), 'utf8')
  const plain = join(dir, 'plain')
  mkdirSync(plain, { recursive: true })
  assert.equal(trustStatus(plain, { path: file }).trusted, true, '纯文件夹直接进')
  const withMcp = join(dir, 'withmcp')
  mkdirSync(withMcp, { recursive: true })
  writeFileSync(join(withMcp, '.mcp.json'), '{}', 'utf8')
  assert.equal(trustStatus(withMcp, { path: file }).trusted, false, '有 .mcp.json 要确认')
})

test('信任预置：子目录与仓库根各写一条，其它项目不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-status-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const sub = join(repo, 'pkg')
  mkdirSync(sub, { recursive: true })
  const file = join(dir, '.claude.json')
  writeFileSync(file, JSON.stringify({ projects: { 'E:\\other': { lastCost: 1 } } }), 'utf8')
  assert.equal(ensureTrusted(sub, { path: file }), true)
  const j = JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, Record<string, unknown>> }
  assert.equal(j.projects[trustKey(repo)]?.['hasTrustDialogAccepted'], true, '仓库根要写')
  assert.equal(j.projects[trustKey(sub)]?.['hasTrustDialogAccepted'], true, '目录自己也要写')
  assert.equal(j.projects['E:\\other']?.['lastCost'], 1, '别人条目不动')
})
test('信任键：Claude 记的是正斜杠写法（E:/a/b），反斜杠条目它不认', () => {
  assert.equal(trustKey('E:\\Develop_E\\lingcub'), 'E:/Develop_E/lingcub')
  assert.equal(trustKey('e:\\x\\y'), 'E:/x/y', '盘符统一大写')
})

test('信任判定：正斜杠条目也算已信任（否则列表会误报「首次要确认」）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-slash-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const file = join(dir, '.claude.json')
  const key = trustKey(repo)
  writeFileSync(file, JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }), 'utf8')
  assert.equal(trustStatus(repo, { path: file }).trusted, true, 'Claude 自己写的条目要认')
  // 再写一次不应制造重复条目
  assert.equal(ensureTrusted(repo, { path: file }), false, '已信任就不重写')
  const j = JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, unknown> }
  assert.deepEqual(Object.keys(j.projects), [key], '不能多出一条反斜杠条目')
})
