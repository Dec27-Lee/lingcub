import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfigLayered, writeOverlay } from '../src/kernel/config.ts'
import { describeConfig, editablePaths } from '../src/kernel/config-schema.ts'
import * as focusDm from '../src/plugins/scenario-focus-dm/index.ts'

const BASE = 'config/lingcub.yaml'

function freshOverlay(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-overlay-'))
  return join(dir, 'local.json')
}

test('配置页：控制台开窗与重点私聊的键都能在页面上改', () => {
  const cfg = loadConfigLayered(BASE, freshOverlay())
  const paths = editablePaths(cfg)
  for (const p of [
    'scenarios.console.openOnMessage',
    'scenarios.focus-dm.enabled',
    'scenarios.focus-dm.dmChatId',
    'scenarios.focus-dm.notifyOnTurnEnd',
    'sessions.staleMinutes',
    'sessions.closeGraceMinutes',
  ]) {
    assert.ok(paths.includes(p), `${p} 应当可编辑`)
  }
  const field = describeConfig(cfg).find((f) => f.path === 'scenarios.console.openOnMessage')
  assert.equal(field?.kind, 'bool')
  assert.equal(field?.group, '场景')
})

test('配置页：把开窗与私聊写进覆盖层后能读回来（校验通过）', () => {
  const overlay = freshOverlay()
  writeFileSync(overlay, '{}', 'utf8')
  writeOverlay(BASE, overlay, {
    scenarios: {
      console: { plugin: 'scenario-console', enabled: true, openOnMessage: true },
      'focus-dm': { plugin: 'scenario-focus-dm', enabled: true, dmChatId: 'oc_dm_test' },
    },
  })
  const cfg = loadConfigLayered(BASE, overlay)
  const consoleCfg = (cfg.scenarios as Record<string, Record<string, unknown>>)['console']
  const dm = (cfg.scenarios as Record<string, Record<string, unknown>>)['focus-dm']
  assert.equal(consoleCfg?.['openOnMessage'], true)
  assert.equal(dm?.['dmChatId'], 'oc_dm_test')
  assert.equal(dm?.['enabled'], true)
})

test('配置页：scenarios 段是 passthrough，类型由插件自己的 zod 把关（写错值会在装配时被拒）', () => {
  const overlay = freshOverlay()
  writeFileSync(overlay, '{}', 'utf8')
  // 覆盖层本身放行（ConfigSchema 对 scenarios 是 passthrough）
  assert.doesNotThrow(() => writeOverlay(BASE, overlay, { scenarios: { 'focus-dm': { dmChatId: 123 } } }))
  // 但插件 zod 会拒绝：这才是真正的闸门
  const parsed = focusDm.manifest.config.safeParse({ dmChatId: 123 })
  assert.equal(parsed.success, false, '插件 zod 必须挡住非字符串 dmChatId')
  const good = focusDm.manifest.config.safeParse({ dmChatId: 'oc_dm' })
  assert.equal(good.success, true)
})
