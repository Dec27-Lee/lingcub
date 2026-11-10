import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { clearUiInfo, findRunningUi, readUiInfo, uiInfoPath, writeUiInfo } from '../../../src/desktop/registry.ts'
import { startUi } from '../../../src/desktop/server.ts'

const ROOT = resolve(import.meta.dirname, '../../..')

test('登记文件：写入能读回，字段不全时视为没有', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-ui-'))
  assert.equal(readUiInfo(root), null)

  writeUiInfo(root, { port: 1234, token: 'abc', pid: process.pid, url: 'http://127.0.0.1:1234/?t=abc' })
  const info = readUiInfo(root)
  assert.equal(info?.port, 1234)
  assert.equal(info?.url, 'http://127.0.0.1:1234/?t=abc')

  writeFileSync(uiInfoPath(root), '{"port":1}')
  assert.equal(readUiInfo(root), null, '缺字段的登记不算数')
})

test('只有进程还活着才算在跑；陈旧登记会被忽略', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-ui-'))
  writeUiInfo(root, { port: 1, token: 't', pid: 999999, url: 'http://127.0.0.1:1/?t=t' })
  assert.equal(findRunningUi(root), null)

  writeUiInfo(root, { port: 1, token: 't', pid: process.pid, url: 'http://127.0.0.1:1/?t=t' })
  assert.equal(findRunningUi(root)?.pid, process.pid)
})

test('清理只删自己写的登记', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-ui-'))
  writeUiInfo(root, { port: 1, token: 't', pid: process.pid + 1, url: 'x' })
  clearUiInfo(root) // 不是自己写的
  assert.notEqual(readUiInfo(root), null)

  writeUiInfo(root, { port: 1, token: 't', pid: process.pid, url: 'x' })
  clearUiInfo(root)
  assert.equal(readUiInfo(root), null)
})

test('面板启动后写登记、关闭后删登记（入口复用的依据）', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-ui-live-'))
  const ui = await startUi({ root, port: 0, idleExitMs: 0 })
  try {
    const info = findRunningUi(root)
    assert.ok(info, '启动后应有可复用的登记')
    assert.equal(info.port, ui.port)
    assert.match(readFileSync(uiInfoPath(root), 'utf8'), new RegExp(String(process.pid)))
  } finally {
    await ui.close()
  }
  assert.equal(readUiInfo(root), null, '关闭后登记应清掉')
})
