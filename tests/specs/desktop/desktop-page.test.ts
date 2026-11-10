import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const html = readFileSync(new URL('../../../src/desktop/app-page.html', import.meta.url), 'utf8')

test('桌面壳：占位符与固定菜单区存在', () => {
  assert.ok(html.includes('__TOKEN__'))
  assert.ok(html.includes('__FIELDS__'))
  assert.ok(html.includes('id="uiNav"') || html.includes('id="pluginNav"'))
  assert.ok(html.includes('data-page="overview"'))
  assert.ok(html.includes('data-page="settings"'))
  assert.ok(html.includes('id="drawer"'))
  assert.ok(html.includes('lingcub.request'))
  assert.ok(html.includes('id="paletteBackdrop"'))
  assert.ok(html.includes('id="msgSearch"'))
})

test('桌面壳：iframe 插槽不携带宿主令牌并启用 sandbox', () => {
  assert.ok(html.includes('sandbox="allow-scripts"'))
  assert.ok(!html.includes('x.url+?t='))
})
