import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { loadConfigLayered } from '../src/kernel/config.ts'
import { startUi } from '../src/desktop/server.ts'
import { acquireLock, buildBundle, RESTART_EXIT_CODE, runRuntime } from '../src/kernel/runtime.ts'

const ROOT = resolve(import.meta.dirname, '..')

/** 临时工作区：配置照抄仓库，但把来源全停掉——运行期测试绝不真连平台。 */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-root-'))
  mkdirSync(join(dir, 'config'), { recursive: true })
  mkdirSync(join(dir, 'prompts'), { recursive: true })
  for (const f of ['lingcub.yaml', 'projects.yaml', 'rules.yaml']) {
    copyFileSync(join(ROOT, 'config', f), join(dir, 'config', f))
  }
  copyFileSync(join(ROOT, 'prompts', 'classify.md'), join(dir, 'prompts', 'classify.md'))
  const yaml = join(dir, 'config', 'lingcub.yaml')
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replaceAll('enabled: true', 'enabled: false'))
  return dir
}

test('单实例锁：第二个进程被拒，释放后可再拿', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lingcub-lock-')), 'lingcub.lock')
  const lock = acquireLock(file)
  assert.equal(readFileSync(file, 'utf8'), String(process.pid))
  assert.throws(() => acquireLock(file), /已有实例在跑/)

  lock.release()
  const again = acquireLock(file)
  again.release()
})

test('单实例锁：陈旧锁（进程已不在）会被接管', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lingcub-lock-')), 'lingcub.lock')
  writeFileSync(file, '999999')
  const lock = acquireLock(file)
  assert.equal(readFileSync(file, 'utf8'), String(process.pid))
  lock.release()
})

test('常驻主循环：没有来源也能跑起来，收到停止信号后优雅退出且释放锁', { timeout: 15_000 }, async () => {
  const root = tempRoot()
  const controller = new AbortController()
  const running = runRuntime({ root, tickMs: 30, signal: controller.signal })
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(existsSync(join(root, 'data/lingcub.lock')), '启动后应持有单实例锁')
  controller.abort()
  await running
  assert.equal(existsSync(join(root, 'data/lingcub.lock')), false, '退出时应释放锁')
  assert.ok(existsSync(join(root, 'data/lingcub.db')), '应建好数据库')
  const log = readFileSync(join(root, 'data/lingcub.log'), 'utf8')
  assert.match(log, /启动：mode=observe/)
  assert.match(log, /没有启用任何来源/)
  assert.match(log, /已退出/)
})

test('常驻主循环：两个实例不能同时跑', { timeout: 15_000 }, async () => {
  const root = tempRoot()
  const first = new AbortController()
  const running = runRuntime({ root, tickMs: 30, signal: first.signal })
  await new Promise((r) => setTimeout(r, 200))

  const second = new AbortController()
  const attempt = runRuntime({ root, tickMs: 30, signal: second.signal })
  // 与超时赛跑：起不来会立刻 reject；起得来会一直是 pending，那就说明锁没挡住
  const outcome = await Promise.race([
    attempt.then(
      () => 'started',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    ),
    new Promise<string>((r) => setTimeout(() => r('pending'), 800)),
  ])
  second.abort()
  await attempt.catch(() => {})
  first.abort()
  await running

  assert.match(outcome, /已有实例在跑/)
})

test('桌面面板：写配置只落覆盖层，基线 YAML 不动', { timeout: 20_000 }, async () => {
  const root = tempRoot()
  const ui = await startUi({ root, port: 0, idleExitMs: 0 })
  const token = new URL(ui.url).searchParams.get('t')
  try {
    const ok = await fetch(`http://127.0.0.1:${ui.port}/api/config?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { mode: 'suggest', 'sources.dingtalk-im.enabled': false } }),
    })
    assert.equal(ok.status, 200)
    assert.match(readFileSync(join(root, 'data/local.json'), 'utf8'), /"mode": "suggest"/)

    // 基线 YAML 一个字节都不该被改
    const base = readFileSync(join(root, 'config/lingcub.yaml'), 'utf8')
    assert.match(base, /mode: observe/)
    assert.match(base, /enabled: false/, '临时工作区的来源本来就是关的')

    // 白名单外的字段被拒
    const bad = await fetch(`http://127.0.0.1:${ui.port}/api/config?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { 'executor_policies.dsh.binary': 'evil' } }),
    })
    assert.equal(bad.status, 400)
    assert.match(((await bad.json()) as { error: string }).error, /页面上没有这一项/)

    // 非法取值被拒
    const invalid = await fetch(`http://127.0.0.1:${ui.port}/api/config?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { mode: 'whatever' } }),
    })
    assert.equal(invalid.status, 400)
  } finally {
    await ui.close()
  }
})

test('桌面面板：无令牌 403，有令牌能拿到真实状态', async () => {
  const ui = await startUi({ root: ROOT, port: 0, idleExitMs: 0 })
  try {
    const noToken = await fetch(`http://127.0.0.1:${ui.port}/api/state`)
    assert.equal(noToken.status, 403)

    const token = new URL(ui.url).searchParams.get('t')
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/state?t=${token}`)
    assert.equal(res.status, 200)
    const state = (await res.json()) as { ok: boolean; mode?: string; workspaces?: unknown[]; ports?: { executors: number } }
    assert.equal(state.ok, true)
    // 期望值取自分层配置（data/local.json 覆盖层可能把档位改过），别写死某一种档位
    const expected = loadConfigLayered(resolve(ROOT, 'config/lingcub.yaml'), resolve(ROOT, 'data/local.json'))
    assert.equal(state.mode, expected.mode)
    assert.equal(state.workspaces?.length, 2)
    assert.equal(state.ports?.executors, 2)
  } finally {
    await ui.close()
  }
})

test('桌面面板：首页只在带令牌时可访问', async () => {
  const ui = await startUi({ root: ROOT, port: 0, idleExitMs: 0 })
  try {
    assert.equal((await fetch(`http://127.0.0.1:${ui.port}/`)).status, 403)
    const page = await fetch(ui.url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /幺幺零 · Lingcub/)
  } finally {
    await ui.close()
  }
})

test('保存并重启：请求文件出现后优雅退出，退出码标记「要重启」', { timeout: 20_000 }, async () => {
  const root = tempRoot()
  const controller = new AbortController()
  const running = runRuntime({ root, tickMs: 30, signal: controller.signal })
  await new Promise((r) => setTimeout(r, 300))

  // 面板按下「保存并重启」写的就是这个文件
  writeFileSync(join(root, 'data/restart-request'), new Date().toISOString(), 'utf8')
  await running

  assert.equal(process.exitCode, RESTART_EXIT_CODE, '用 75 告诉入口脚本该拉起新进程')
  assert.equal(existsSync(join(root, 'data/restart-request')), false, '请求文件用完要删掉，否则会重启循环')
  process.exitCode = 0
})

test('面板：保存配置失败时不写重启请求（校验不过就不重启）', { timeout: 20_000 }, async () => {
  const root = tempRoot()
  const ui = await startUi({ root, port: 0, idleExitMs: 0 })
  const token = new URL(ui.url).searchParams.get('t')
  try {
    const bad = await fetch(`http://127.0.0.1:${ui.port}/api/config?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { mode: '不存在的档位' } }),
    })
    assert.equal(bad.status, 400)
    assert.equal(existsSync(join(root, 'data/restart-request')), false)

    const ok = await fetch(`http://127.0.0.1:${ui.port}/api/restart?t=${token}`, { method: 'POST' })
    assert.equal(ok.status, 200)
    assert.equal(existsSync(join(root, 'data/restart-request')), true)
  } finally {
    await ui.close()
  }
})

test('场景控制权：runtime 装配前按 control.* 过滤 console', async () => {
  const root = tempRoot()
  const yaml = join(root, 'config', 'lingcub.yaml')
  let text = readFileSync(yaml, 'utf8')
  text = text.replace(/scenarios:\r?\n/, 'scenarios:\n  console:\n    plugin: scenario-console\n    enabled: true\n')
  text += '\ncontrol:\n  status: pipeline\n  stop: pipeline\n  new: pipeline\n  messages: pipeline\n'
  writeFileSync(yaml, text)

  const logs: string[] = []
  const off = await buildBundle(root, (l, m) => logs.push(`${l} ${m}`))
  assert.equal(off.v2Plugins.includes('scenario-console'), false)
  assert.ok(logs.some((l) => l.includes('scenario-console') && l.includes('未装配')), JSON.stringify(logs).slice(0,700))
  off.store.close()

  writeFileSync(
    yaml,
    text.replace('status: pipeline', 'status: scenario').replace('stop: pipeline', 'stop: scenario').replace('new: pipeline', 'new: scenario'),
  )
  const on = await buildBundle(root, () => {})
  assert.equal(on.v2Plugins.includes('scenario-console'), true)
  on.store.close()
})






