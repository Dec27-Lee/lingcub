import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startUi } from '../../../src/desktop/server.ts'
import { pluginStatuses } from '../../../src/desktop/plugins.ts'
import type { InstalledPlugin } from '../../../src/kernel/plugin-v2/catalog.ts'

/** 最小 root：只够 loadConfigLayered 用。 */
function makeRoot(prefix: string, config = 'mode: auto\nstore:\n  path: data/p.db\n'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'config/lingcub.yaml'), config, 'utf8')
  return root
}

/**
 * 临时插件目录放在仓库 `data/` 下：它继承仓库 package.json 的 type=module，
 * `index.ts` 入口才能在 --experimental-strip-types 下被 discovery import。
 */
function makePluginDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'data', 'tmp-desktop-plugins-'))
  mkdirSync(join(dir, 'source-x'))
  writeFileSync(
    join(dir, 'source-x', 'index.ts'),
    `import { z } from 'zod'
export const manifest = { id: 'source-x', kind: 'source', config: z.object({}) }
export function setup() {}
`,
    'utf8',
  )
  mkdirSync(join(dir, 'capability-y'))
  writeFileSync(
    join(dir, 'capability-y', 'index.ts'),
    `import { z } from 'zod'
export const manifest = { v: 2, id: 'capability-y', roles: ['capability'], activation: 'hot', provides: [], config: z.object({}) }
export function setup() {}
`,
    'utf8',
  )
  return dir
}

test('插件台账：v1/v2 都扫，启用状态与配置一致', async () => {
  const root = makeRoot(
    'lingcub-plugins-root-',
    'mode: auto\nstore:\n  path: data/p.db\nplugins:\n  cap:\n    plugin: capability-y\n    enabled: true\n',
  )
  const dir = makePluginDir()
  try {
    const st = await pluginStatuses(root, dir)
    assert.deepEqual(
      st.installed.map((p) => p.id),
      ['capability-y', 'source-x'],
    )
    const byId = new Map(st.installed.map((p) => [p.id, p]))
    const v1 = byId.get('source-x') as InstalledPlugin
    assert.equal(v1.api, 'v1')
    assert.deepEqual(v1.roles, ['source'])
    assert.equal(v1.activation, 'restart')
    assert.equal(v1.enabled, false)
    assert.equal(v1.configured, false)
    const v2 = byId.get('capability-y') as InstalledPlugin
    assert.equal(v2.api, 'v2')
    assert.deepEqual(v2.roles, ['capability'])
    assert.equal(v2.activation, 'hot')
    assert.equal(v2.enabled, true)
    assert.equal(v2.configured, true)

    assert.deepEqual(st.enabled, ['capability-y'])
    assert.deepEqual(st.disabled, ['source-x'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板：/api/plugins 返回清单，toggle 未知插件不 500', async () => {
  const root = makeRoot('lingcub-plugins-ui-')
  const ui = await startUi({ root, port: 0, idleExitMs: 0, open: false })
  const base = `http://127.0.0.1:${ui.port}`
  try {
    const token = new URL(ui.url).searchParams.get('t') as string

    const page = await (await fetch(ui.url)).text()
    assert.match(page, /id="pluginNav"/)

    const r = await fetch(`${base}/api/plugins?t=${token}`)
    assert.equal(r.status, 200)
    const d = (await r.json()) as {
      ok: boolean
      installed: InstalledPlugin[]
      enabled: string[]
      disabled: string[]
    }
    assert.equal(d.ok, true)
    assert.ok(d.installed.length > 0, '真实插件目录至少有一个插件')
    for (const p of d.installed) {
      assert.equal(typeof p.id, 'string')
      assert.ok(p.api === 'v1' || p.api === 'v2', `api 只能是 v1/v2：${String(p.api)}`)
      assert.ok(Array.isArray(p.roles))
      assert.equal(typeof p.enabled, 'boolean')
      assert.equal(typeof p.configured, 'boolean')
    }
    const ids = d.installed.map((p) => p.id)
    assert.deepEqual([...d.enabled, ...d.disabled].sort(), [...ids].sort(), '启用/停用恰好划分已安装清单')
    assert.equal(new Set([...d.enabled, ...d.disabled]).size, ids.length, '启用/停用不重叠')

    const denied = await fetch(`${base}/api/plugins`)
    assert.equal(denied.status, 403, '不带令牌一律 403')

    const unknown = await fetch(`${base}/api/plugins/toggle?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'not-a-plugin', enabled: true }),
    })
    assert.equal(unknown.status, 400, '未知插件是请求错误，不是 500')
    const ud = (await unknown.json()) as { ok: boolean; error: string }
    assert.equal(ud.ok, false)
    assert.match(ud.error, /not-a-plugin/)

    const badBody = await fetch(`${base}/api/plugins/toggle?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'not-a-plugin' }),
    })
    assert.equal(badBody.status, 400, 'enabled 必须是布尔值')

    const target = d.installed[0] as InstalledPlugin
    const on = !target.enabled
    const tr = await fetch(`${base}/api/plugins/toggle?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: target.id, enabled: on }),
    })
    assert.equal(tr.status, 200)
    const td = (await tr.json()) as { ok: boolean; applied: boolean; restartRequired: boolean; message: string }
    assert.equal(td.ok, true)
    assert.equal(typeof td.applied, 'boolean')
    assert.equal(typeof td.restartRequired, 'boolean')
    assert.equal(typeof td.message, 'string')
    assert.ok(td.message.length > 0, 'toggle 必须给出可显示的结果说明')
    assert.equal(td.applied, true, '真实插件目录里的插件要能落盘')
    const after = (await (await fetch(`${base}/api/plugins?t=${token}`)).json()) as {
      installed: InstalledPlugin[]
    }
    assert.equal(after.installed.find((p) => p.id === target.id)?.enabled, on, '写入后清单要跟着变')
    assert.ok(existsSync(join(root, 'data/local.json')), '开关只写临时 root 的覆盖层')

    const back = await fetch(`${base}/api/plugins/toggle?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: target.id, enabled: target.enabled }),
    })
    assert.equal(back.status, 200)
    assert.equal(((await back.json()) as { applied: boolean }).applied, true, '开关能来回改')
    const restored = (await (await fetch(`${base}/api/plugins?t=${token}`)).json()) as {
      installed: InstalledPlugin[]
    }
    assert.equal(restored.installed.find((p) => p.id === target.id)?.enabled, target.enabled)
  } finally {
    await ui.close()
    rmSync(root, { recursive: true, force: true })
  }
})
