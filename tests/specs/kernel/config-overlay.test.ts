import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deepMerge, loadConfigLayered, writeOverlay } from '../../../src/kernel/config.ts'

const BASE = `
mode: observe
store: { path: data/lingcub.db }
sources:
  feishu-im: { enabled: true, plugin: source-feishu-im }
  dingtalk-im: { enabled: true, plugin: source-dingtalk }
channels:
  feishu: { plugin: channel-feishu, defaultChatId: '' }
classifiers:
  llm: { plugin: classifier-llm, prompt: prompts/classify.md, minConfidence: 0.3 }
executor_policies:
  dsh: { plugin: executor-dsh, allowRoots: ['E:\\Develop_E'] }
`

function root(): { dir: string; configPath: string; overlayPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-overlay-'))
  const configPath = join(dir, 'config/lingcub.yaml')
  const overlayPath = join(dir, 'data/local.json')
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(configPath, BASE, 'utf8')
  return { dir, configPath, overlayPath }
}

test('深合并：对象递归，数组整体替换', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } })
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [9] }), { a: [9] })
  assert.deepEqual(deepMerge({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
})

test('没有覆盖层时读基线；有覆盖层时覆盖层赢', () => {
  const { configPath, overlayPath } = root()
  assert.equal(loadConfigLayered(configPath, overlayPath).mode, 'observe')
  writeOverlay(configPath, overlayPath, { mode: 'suggest' })
  assert.equal(loadConfigLayered(configPath, overlayPath).mode, 'suggest')
})

test('覆盖层只改一个字段，其余基线保持不变', () => {
  const { configPath, overlayPath } = root()
  writeOverlay(configPath, overlayPath, { sources: { 'feishu-im': { enabled: false } } })
  const cfg = loadConfigLayered(configPath, overlayPath)
  assert.equal(cfg.sources['feishu-im']?.enabled, false)
  assert.equal(cfg.sources['dingtalk-im']?.enabled, true, '没被覆盖的来源应保持基线值')
  assert.equal(cfg.classifiers.llm?.minConfidence, 0.3)
})

test('覆盖层不合法时拒绝写盘，旧覆盖层保持不变', () => {
  const { configPath, overlayPath } = root()
  writeOverlay(configPath, overlayPath, { mode: 'suggest' })
  const before = readFileSync(overlayPath, 'utf8')
  assert.throws(() => writeOverlay(configPath, overlayPath, { mode: 'bogus' }), /校验失败/)
  assert.equal(readFileSync(overlayPath, 'utf8'), before, '校验失败不能动已有覆盖层')
  assert.equal(loadConfigLayered(configPath, overlayPath).mode, 'suggest')
})

test('覆盖层合并后仍不合法时也拒绝（多个字段互相影响）', () => {
  const { configPath, overlayPath } = root()
  assert.throws(
    () => writeOverlay(configPath, overlayPath, { executor_policies: { dsh: { allowRoots: 'not-an-array' } } }),
    /校验失败/,
  )
  assert.equal(existsSync(overlayPath), false, '一次都没成功写过时不应留下文件')
})

test('多次保存是累加的，不是互相覆盖', () => {
  const { configPath, overlayPath } = root()
  writeOverlay(configPath, overlayPath, { mode: 'suggest' })
  writeOverlay(configPath, overlayPath, { channels: { feishu: { defaultChatId: 'oc_1' } } })
  const cfg = loadConfigLayered(configPath, overlayPath)
  assert.equal(cfg.mode, 'suggest')
  assert.equal(cfg.channels.feishu?.defaultChatId, 'oc_1')
})
