import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { cleanupImages, runCleanup, trimLogs } from '../src/kernel/cleanup.ts'
import { openStore } from '../src/kernel/store.ts'

const DAY = 86_400_000

test('图片清理：按天/按会话的目录过期就整目录删，没过期的一个不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-img-'))
  const images = join(root, 'images')
  mkdirSync(join(images, '2026-10-01'), { recursive: true })
  mkdirSync(join(images, '2026-11-03'), { recursive: true })
  writeFileSync(join(images, '2026-10-01', 'a.png'), 'x')
  writeFileSync(join(images, '2026-11-03', 'b.png'), 'x')

  const now = Date.now()
  utimesSync(join(images, '2026-10-01'), new Date(now - 40 * DAY), new Date(now - 40 * DAY))

  const r = cleanupImages(images, 7, now)
  assert.equal(r.dirs, 1, '过期的那个目录删掉')
  assert.ok(!existsSync(join(images, '2026-10-01')))
  assert.ok(existsSync(join(images, '2026-11-03')), '今天的不能被删')
})

test('图片清理：目录不存在也不报错', () => {
  assert.deepEqual(cleanupImages(join(tmpdir(), 'lingcub-nope-xyz'), 7), { dirs: 0, files: 0 })
})

test('日志修剪：超过上限只留尾部一半', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-log-'))
  const f = join(dir, 'a.log')
  writeFileSync(f, 'x'.repeat(1000))
  assert.equal(trimLogs(dir, 500), 1)
  const size = statSync(f).size
  assert.equal(size, 500, '留一半')
  assert.equal(trimLogs(dir, 500), 0, '没超限时什么都不做')
})

test('清理总入口：图片与日志一起跑，互不影响', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-clean-'))
  const images = join(root, 'data', 'images', 'old')
  mkdirSync(images, { recursive: true })
  writeFileSync(join(images, 'x.png'), 'x')
  const old = new Date(Date.now() - 30 * DAY)
  utimesSync(join(root, 'data', 'images', 'old'), old, old)
  const logs = join(root, 'logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'huge.log'), 'y'.repeat(4000))

  const r = runCleanup({ dataDir: join(root, 'data'), logDir: logs, imageTtlDays: 7, maxLogBytes: 1000 })
  assert.equal(r.images, 1)
  assert.equal(r.logs, 1)
})

test('残留提问：超时未答的清掉，答过的留着', () => {
  const store = openStore(':memory:')
  try {
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    store.insertQuestion({
      id: 'q-old',
      sessionId: 's1',
      questions: [{ question: '甲?', options: [] }],
      createdAt: old,
      expiresAt: old,
    })
    assert.equal(store.pruneQuestions(2 * 3_600_000), 1)
    assert.equal(store.pruneQuestions(2 * 3_600_000), 0, '再跑一次不重复计数')
    void future
  } finally {
    store.close()
  }
})

test('消息映射：超过 TTL 的清掉，引用旧消息就退化成别的路由', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-map-'))
  const file = join(dir, 'db.sqlite')
  const store = openStore(file)
  try {
    store.mapMessage('om_old', 'sess-1', 'oc_1')
    // 把创建时间改老：直接动库，模拟 15 天前的映射
    store.close()
    const db = new DatabaseSync(file)
    db.prepare('UPDATE message_map SET created_at = ? WHERE message_id = ?').run(
      new Date(Date.now() - 15 * DAY).toISOString(),
      'om_old',
    )
    db.close()

    const s2 = openStore(file)
    assert.equal(s2.pruneMessageMap(14 * DAY), 1)
    assert.equal(s2.sessionByMessage('om_old'), null)
    s2.close()
  } finally {
    try {
      store.close()
    } catch {
      /* 已关 */
    }
  }
})

test('图片清理：按目录名（日期）判过期，不按 mtime——否则活跃目录里的旧图永远删不掉', async () => {
  const { cleanupImages } = await import('../src/kernel/cleanup.ts')
  const { imageDayDir } = await import('../src/kernel/images.ts')
  const base = join(mkdtempSync(join(tmpdir(), 'lingcub-imgday-')), 'images')

  // 一个 30 天前的日期目录，但刚刚往里写了一张图（mtime 是新的）
  const old = imageDayDir(base, new Date(Date.now() - 30 * 86_400_000))
  mkdirSync(old, { recursive: true })
  writeFileSync(join(old, 'om_x_1.png'), 'x')
  // 今天的目录
  const today = imageDayDir(base)
  mkdirSync(today, { recursive: true })
  writeFileSync(join(today, 'om_y_1.png'), 'x')
  // 老结构（会话目录，名字不是日期）：mtime 判定仍然生效
  const legacy = join(base, 'sess-1')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'img_z'), 'x')

  const r = cleanupImages(base, 7)
  assert.equal(r.dirs, 1, '只该删掉那个 30 天前的日期目录')
  assert.equal(existsSync(old), false, '日期目录过期就删（哪怕里面文件是新的）')
  assert.equal(existsSync(today), true, '今天的目录不能动')
  assert.equal(existsSync(legacy), true, '老结构刚写过，mtime 未过期，保留')
})
