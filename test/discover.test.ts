import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discover, lastCwd, underRoots } from '../src/plugin-kit/claude-discover.ts'

function fixture(): { root: string; claudeJson: string; projectsDir: string; work: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-discover-'))
  const work = join(dir, 'work')
  const outside = join(dir, 'outside')
  mkdirSync(join(work, 'repo-a'), { recursive: true })
  mkdirSync(join(work, 'repo-b'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  const claudeJson = join(dir, '.claude.json')
  writeFileSync(
    claudeJson,
    JSON.stringify({ projects: { [join(work, 'repo-a')]: {}, [outside]: {} } }),
    'utf8',
  )
  const projectsDir = join(dir, 'projects')
  const slug = join(projectsDir, '-slug-')
  mkdirSync(slug, { recursive: true })
  // 转录里记录的 cwd 才是「真的用过」的那一个
  writeFileSync(
    join(slug, 's1.jsonl'),
    `{"type":"user","cwd":"${join(work, 'repo-b').replace(/\\/g, '\\\\')}","message":"hi"}\n`,
    'utf8',
  )
  return { root: work, claudeJson, projectsDir, work }
}

test('工作区扫描：登记过的 + 转录里出现过的，且只在允许根之内', () => {
  const f = fixture()
  const list = discover({
    roots: [f.root],
    claudeJson: f.claudeJson,
    projectsDir: f.projectsDir,
  })
  const roots = list.map((w) => w.root)
  assert.ok(roots.some((r) => r.endsWith('repo-a')), 'claude.json 里登记的目录要出现')
  assert.ok(roots.some((r) => r.endsWith('repo-b')), '转录里出现过的目录要出现')
  assert.ok(!roots.some((r) => r.includes('outside')), '允许根之外的目录不能列出来')
})

test('允许根判断：根本身算在内，前缀相近但不同级的不算', () => {
  assert.equal(underRoots('E:\\Develop_E\\tt', ['E:\\Develop_E\\tt']), true)
  assert.equal(underRoots('E:\\Develop_E\\tt\\a\\b', ['E:\\Develop_E\\tt']), true)
  assert.equal(underRoots('E:\\Develop_E\\ttx', ['E:\\Develop_E\\tt']), false, 'ttx 不是 tt 的子目录')
})

test('转录尾部取 cwd：只读尾巴也能拿到最后一条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-cwd-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(
    file,
    ['{"cwd":"C:\\\\old"}', '{"cwd":"C:\\\\new\\\\repo"}', '{"type":"assistant"}'].join('\n'),
    'utf8',
  )
  assert.equal(lastCwd(file), 'C:\\new\\repo')
})
