import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { HOOK_SPECS, mergeHookEntry } from '../../../src/plugin-kit/hook-config.ts'
import {
  applySync,
  ccSwitchRunning,
  hasHook,
  hookPlanOf,
  mergeHooksInto,
  planSync,
  readCcSwitch,
  type HookPlan,
} from '../../../src/plugin-kit/cc-switch.ts'

const silent = (): void => {}

const PLAN: HookPlan = hookPlanOf({
  stop: 'node x hook post stop',
  notify: 'node x hook post notify',
  ask: 'node x hook post ask',
  permission: 'node x hook post permission',
  sessionStart: 'node x hook post session-start',
})

/** 造一个和真库同形状的 cc-switch 库：settings 表 + providers 表。 */
function makeDb(dir: string): string {
  const file = join(dir, 'cc-switch.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`)
  db.exec(`CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT)`)
  db.prepare("INSERT INTO settings (key, value) VALUES ('common_config_claude', ?)").run(
    JSON.stringify({
      env: { ANTHROPIC_MODEL: 'x' },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }] },
    }),
  )
  // true：自身不带非 env 字段，钩子应该只写通用配置
  db.prepare("INSERT INTO providers (id, app_type, name, settings_config, meta) VALUES (?,?,?,?,?)").run(
    'p-true',
    'claude',
    '带通用配置的服务商',
    JSON.stringify({ env: { ANTHROPIC_MODEL: 'y' } }),
    JSON.stringify({ commonConfigEnabled: true }),
  )
  // false：自身保留完整副本，钩子也得写进它
  db.prepare("INSERT INTO providers (id, app_type, name, settings_config, meta) VALUES (?,?,?,?,?)").run(
    'p-false',
    'claude',
    '独立配置的服务商',
    JSON.stringify({ env: { ANTHROPIC_MODEL: 'z' }, permissions: { defaultMode: 'bypassPermissions' } }),
    JSON.stringify({ commonConfigEnabled: false }),
  )
  // 同名 UUID 的 claude-desktop 条目：按 id 更新会误伤它，必须碰不到
  db.prepare("INSERT INTO providers (id, app_type, name, settings_config, meta) VALUES (?,?,?,?,?)").run(
    'p-false',
    'claude-desktop',
    '桌面端',
    JSON.stringify({ env: { ANTHROPIC_MODEL: 'desktop' } }),
    JSON.stringify({ commonConfigEnabled: false }),
  )
  db.close()
  return file
}

test('没装 cc-switch 时返回 null（不该影响没用这个工具的人）', () => {
  assert.equal(readCcSwitch(join(tmpdir(), 'lingcub-no-such-dir', 'cc-switch.db')), null)
})

test('探查：解析通用配置与每个服务商的 commonConfigEnabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-ccs-'))
  try {
    const state = readCcSwitch(makeDb(dir))
    assert.ok(state)
    assert.equal(Object.keys(state.providers).length, 2, '只读 app_type=claude 的条目')
    assert.equal(
      state.providers.some((p) => p.name === '桌面端'),
      false,
      'claude-desktop 不该混进来',
    )
    assert.equal(state.providers.find((p) => p.name === '带通用配置的服务商')?.commonConfigEnabled, true)
    assert.equal(state.providers.find((p) => p.name === '独立配置的服务商')?.commonConfigEnabled, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('计划：只改通用配置与 commonConfigEnabled=false 的条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-ccs-'))
  try {
    const state = readCcSwitch(makeDb(dir))
    assert.ok(state)
    const plan = planSync(state, PLAN, { running: false })
    assert.equal(plan.common, true, '通用配置缺钩子')
    assert.deepEqual(
      plan.providers.map((p) => p.name),
      ['独立配置的服务商'],
      '带通用配置的条目自身不该被写（会与通用配置打架）',
    )
    assert.equal(plan.blockedBy, null)

    const blocked = planSync(state, PLAN, { running: true })
    assert.equal(blocked.blockedBy, 'running', 'cc-switch 在跑时不能写库')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hasHook：只有带 timeout 的才算装上（旧形状要升级）', () => {
  const withTimeout = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c', timeout: 25 }] }] } }
  const oldShape = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] } }
  assert.equal(hasHook(withTimeout, 'Stop', 'c'), true)
  assert.equal(hasHook(oldShape, 'Stop', 'c'), false, '缺 timeout 的旧条目要重写')
  assert.equal(hasHook({}, 'Stop', 'c'), false)
})

test('合并：保留别人的钩子与非钩子键，只替换同命令的条目', () => {
  const base = {
    env: { A: '1' },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }] },
  }
  const merged = mergeHooksInto(base, PLAN) as {
    env: Record<string, string>
    hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>
  }
  assert.deepEqual(merged.env, { A: '1' }, '别的键必须原样保留')
  assert.equal(merged.hooks['UserPromptSubmit']?.length, 1, '别人家的钩子不能被吃掉')
  assert.equal(merged.hooks['PreToolUse']?.[0]?.matcher, 'AskUserQuestion')
  assert.equal(merged.hooks['PreToolUse']?.[0]?.hooks[0]?.timeout, HOOK_SPECS.ask.timeout)

  // 再合并一次不重复（幂等）
  const again = mergeHooksInto(merged as unknown as Record<string, unknown>, PLAN) as typeof merged
  assert.equal(again.hooks['PreToolUse']?.length, 1)
})

test('落盘：写通用配置与独立条目，不碰 claude-desktop，且先备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-ccs-'))
  try {
    const file = makeDb(dir)
    const state = readCcSwitch(file)
    assert.ok(state)
    const r = applySync(state, PLAN, silent)
    assert.equal(r.changed, true)
    assert.ok(r.backup && existsSync(r.backup), '写库前必须备份')

    const after = readCcSwitch(file)
    assert.ok(after)
    assert.equal(hasHook(after.common, 'PreToolUse', 'node x hook post ask'), true, '通用配置要带钩子')
    const independent = after.providers.find((p) => p.name === '独立配置的服务商')
    assert.equal(hasHook(independent!.settings, 'PreToolUse', 'node x hook post ask'), true, '独立条目也要带')
    // claude-desktop 不在读取范围内，直接查库确认它原样没动
    const raw = new DatabaseSync(file, { readOnly: true })
    const desktopRow = raw.prepare("select settings_config from providers where app_type = 'claude-desktop'").get() as {
      settings_config: string
    }
    raw.close()
    assert.equal(JSON.parse(desktopRow.settings_config).hooks, undefined, 'claude-desktop 不能被误伤')
    // 原来的 env / permissions 不能被抹掉
    assert.deepEqual(independent!.settings['permissions'], { defaultMode: 'bypassPermissions' })

    // 再跑一次：没有要改的就返回 nothing-to-do（幂等）
    const again = applySync(after, PLAN, silent)
    assert.equal(again.changed, false)
    assert.equal(again.skipped, 'nothing-to-do')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('进程检测：tasklist 里有 cc-switch.exe 才算在跑', () => {
  assert.equal(ccSwitchRunning(() => 'cc-switch.exe   23992 Console   1   120,000 K'), true)
  assert.equal(ccSwitchRunning(() => '信息: 没有运行的任务匹配指定标准。'), false)
  assert.equal(
    ccSwitchRunning(() => {
      throw new Error('tasklist 不可用')
    }),
    false,
    '检测失败不能挡住安装',
  )
})
