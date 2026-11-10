import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discoverUi, readUiAsset, readUiPage } from '../../../src/desktop/ui-catalog.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-ui-'))
  const plugin = join(root, 'scenario-demo')
  mkdirSync(join(plugin, 'ui'), { recursive: true })
  writeFileSync(
    join(plugin, 'ui.json'),
    JSON.stringify({
      nav: [{ id: 'main', label: '示例', page: 'index.html' }],
      slots: [{ slot: 'main.header', page: 'header.html', height: 40 }],
    }),
  )
  writeFileSync(join(plugin, 'ui', 'index.html'), '<h1>demo</h1>')
  writeFileSync(join(plugin, 'ui', 'header.html'), '<b>demo</b>')
  return root
}

test('UI 目录：只收启用插件的 nav/slot', () => {
  const root = fixture()
  try {
    const ui = discoverUi(root, new Set(['scenario-demo']))
    assert.equal(ui.nav[0]?.label, '示例')
    assert.equal(ui.slots[0]?.slot, 'main.header')
    assert.equal(ui.errors.length, 0)
    assert.equal(readUiPage(root, 'scenario-demo', 'index.html')?.body, '<h1>demo</h1>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('UI 目录：路径穿越和未启用插件不暴露', () => {
  const root = fixture()
  try {
    assert.equal(readUiPage(root, 'scenario-demo', '../index.ts'), null)
    assert.equal(readUiAsset(root, 'scenario-demo', '../index.ts'), null)
    assert.equal(discoverUi(root, new Set()).nav.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
