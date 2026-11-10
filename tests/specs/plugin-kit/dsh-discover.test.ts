import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discoverDshSessions, discoverDshWorkspaces, sessionFileMtime } from '../../../src/plugin-kit/dsh-discover.ts'

const NOW = Date.parse('2026-11-06T04:00:00.000Z')
const MIN = 60_000

function cacheRecord(cwd: string, title: string): string {
  return JSON.stringify({ version: 4, record: { identity: { cwd }, rows: { title: { val: title } } } })
}

/** 造一份假 dsh 存储：cacheDir 里放会话 json，sessionsDir 里放会话文件。 */
function fixture(opts: { cwd: string; title?: string; ageMs?: number; id?: string; sessionFileAgeMs?: number }): {
  root: string
  cacheDir: string
  sessionsDir: string
  id: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  const cacheDir = join(root, 'cache')
  const sessionsDir = join(root, 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  const id = opts.id ?? '01348c90-f47e-44a7-a514-de2f526f0b03'
  writeFileSync(join(cacheDir, `${id}.json`), cacheRecord(opts.cwd, opts.title ?? '修订单分页'))
  const ageMs = opts.ageMs ?? 5 * MIN
  const past = new Date(NOW - ageMs)
  // 用 fs.utimesSync 精确控时：mtime 就是「最近活动」的唯一依据
  mkdirSync(join(sessionsDir, '--fake-slug--', id), { recursive: true })
  const file = join(sessionsDir, '--fake-slug--', id, 'session.v4.jsonl.zstd')
  writeFileSync(file, 'x')
  const when = new Date(NOW - (opts.sessionFileAgeMs ?? ageMs))
  utimesSync(file, when, when)
  utimesSync(join(cacheDir, `${id}.json`), past, past)
  return { root, cacheDir, sessionsDir, id }
}

test('dsh 会话发现：读 projcache 的 cwd/标题，按 allowRoots 过滤', () => {
  const f = fixture({ cwd: 'E:\\Develop_E\\lingcub' })
  const inside = discoverDshSessions({
    roots: ['E:\\Develop_E'],
    cacheDir: f.cacheDir,
    sessionsDir: f.sessionsDir,
    nowMs: NOW,
  })
  assert.equal(inside.length, 1)
  assert.equal(inside[0]?.cwd, 'E:\\Develop_E\\lingcub')
  assert.equal(inside[0]?.title, '修订单分页')

  const outside = discoverDshSessions({
    roots: ['E:\\Develop_E\\tt'],
    cacheDir: f.cacheDir,
    sessionsDir: f.sessionsDir,
    nowMs: NOW,
  })
  assert.deepEqual(outside, [], 'allowRoots 之外一律不列')
})

test('dsh 会话发现：文件新近更新的算在跑，旧的算历史', () => {
  const fresh = fixture({ cwd: 'E:\\Develop_E\\lingcub', sessionFileAgeMs: 10_000 })
  const live = discoverDshSessions({
    roots: ['E:\\Develop_E'],
    cacheDir: fresh.cacheDir,
    sessionsDir: fresh.sessionsDir,
    nowMs: NOW,
  })
  assert.equal(live[0]?.running, true)

  const stale = fixture({ cwd: 'E:\\Develop_E\\lingcub', sessionFileAgeMs: 10 * MIN })
  const history = discoverDshSessions({
    roots: ['E:\\Develop_E'],
    cacheDir: stale.cacheDir,
    sessionsDir: stale.sessionsDir,
    nowMs: NOW,
  })
  assert.equal(history[0]?.running, false, '不能把两小时没动的会话说成在跑')
})

test('dsh 会话发现：超过 resumeDays 的会话不列', () => {
  const f = fixture({ cwd: 'E:\\Develop_E\\lingcub', ageMs: 10 * 24 * 60 * MIN })
  const out = discoverDshSessions({
    roots: ['E:\\Develop_E'],
    cacheDir: f.cacheDir,
    sessionsDir: f.sessionsDir,
    nowMs: NOW,
    maxAgeDays: 5,
  })
  assert.deepEqual(out, [])
})

test('dsh 工作区：同一 cwd 只列一次，按最近活动排序', () => {
  const a = fixture({ cwd: 'E:\\Develop_E\\lingcub', ageMs: 30 * MIN, id: 'aaaaaaaa-0000-0000-0000-000000000001' })
  const b = fixture({ cwd: 'E:\\Develop_E\\tt', ageMs: 5 * MIN, id: 'bbbbbbbb-0000-0000-0000-000000000002' })
  // 两个 fixture 各自独立的 cacheDir，合并成一个目录来测「去重 + 排序」
  const merge = (from: string, to: string): void => {
    for (const f of readdirSync(from)) copyFileSync(join(from, f), join(to, f))
  }
  merge(a.cacheDir, b.cacheDir)
  const out = discoverDshWorkspaces({
    roots: ['E:\\Develop_E'],
    cacheDir: b.cacheDir,
    sessionsDir: b.sessionsDir,
    nowMs: NOW,
  })
  assert.deepEqual(
    out.map((w) => w.label),
    ['tt', 'lingcub'],
  )
})

test('dsh 会话文件定位：找不到会话目录返回 undefined，不抛错', () => {
  const f = fixture({ cwd: 'E:\\Develop_E\\lingcub' })
  assert.equal(typeof sessionFileMtime(f.sessionsDir, f.id), 'number')
  assert.equal(sessionFileMtime(f.sessionsDir, 'no-such-session'), undefined)
  assert.equal(sessionFileMtime(join(f.root, 'missing'), 'x'), undefined)
})
