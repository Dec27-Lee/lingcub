import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

const REPO = resolve(import.meta.dirname, '..')

function run(args: string[]): string {
  const r = spawnSync(process.execPath, [resolve(REPO, 'scripts/switch.mjs'), ...args], {
    cwd: REPO,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  return `${r.stdout}${r.stderr}`
}

test('切换预演：列出四步且声明「没做任何事」', () => {
  const out = run([])
  assert.match(out, /切换计划/)
  assert.match(out, /停旧的事件消费者/)
  assert.match(out, /装 claude 钩子/)
  assert.match(out, /newTopicPolicy=open/)
  assert.match(out, /预演（没做任何事）/, '默认不能有任何副作用')
})

test('回滚预演：说清停什么、还原什么，并提醒旧桥接要手动拉起', () => {
  const out = run(['--rollback'])
  assert.match(out, /回滚计划/)
  assert.match(out, /停掉 lingcub 常驻/)
  assert.match(out, /还原 claude 钩子/)
  assert.match(out, /预演（没做任何事）/)
})

test('安全闸：只给 --apply 而没有确认变量时，一行都不动', () => {
  const r = spawnSync(process.execPath, [resolve(REPO, 'scripts/switch.mjs'), '--apply'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, LINGCUB_SWITCH_CONFIRM: '' },
  })
  const out = `${r.stdout}${r.stderr}`
  assert.match(out, /缺少确认变量/)
  assert.match(out, /预演（没做任何事）/)
  assert.ok(!/已拉起 lingcub run/.test(out), '没有确认变量时绝不能真的拉起')
})

test('回滚同样要确认变量', () => {
  const r = spawnSync(process.execPath, [resolve(REPO, 'scripts/switch.mjs'), '--rollback', '--apply'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, LINGCUB_SWITCH_CONFIRM: '' },
  })
  assert.match(`${r.stdout}${r.stderr}`, /缺少确认变量/)
})

test('切换脚本：锁文件是纯 pid 字符串也要认得出来（否则永远看不到 lingcub 在跑）', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'lingcub-lock-'))
  const lock = join(root, 'lingcub.lock')
  // 与 kernel/runtime.acquireLock 写出的格式一致：就是一个数字
  writeFileSync(lock, '53052', 'utf8')

  const { readLockPid } = await import('../scripts/switch-lib.mjs')
  assert.equal(readLockPid(lock), 53052)
  writeFileSync(lock, '{"pid": 1234}', 'utf8')
  assert.equal(readLockPid(lock), 1234, '老的 JSON 形状也要认')
  writeFileSync(lock, 'nonsense', 'utf8')
  assert.equal(readLockPid(lock), null, '认不出就当没在跑，不瞎猜')
})

test('切换判定：看门狗先停、自己的消费不动、别人的才停（含父子链传递）', async () => {
  const { planSwitch, rollbackChecklist } = await import('../scripts/switch-lib.mjs')
  const plan = planSwitch({
    lingcubPid: 100,
    watchdogs: [{ pid: 900 }],
    consumers: [
      { pid: 100, parent: 1 }, // lingcub 自己不该在这个表里，但即便在也不动
      { pid: 200, parent: 100 }, // 我们起的 node 包装
      { pid: 201, parent: 200 }, // 它拉起的 lark-cli（父不是 lingcub，要顺着链认）
      { pid: 300, parent: 55 }, // 旧桥接的
      { pid: 301, parent: 300 },
    ],
  })
  assert.deepEqual(plan.watchdogPids, [900], '看门狗要先停')
  assert.deepEqual(plan.ourConsumers, [100, 200, 201], '自己的链上一个都不能动')
  assert.deepEqual(plan.theirConsumers, [300, 301], '别人的才停')

  // 没有 lingcub 在跑时：所有消费进程都算别人的
  const fresh = planSwitch({ consumers: [{ pid: 1, parent: 0 }, { pid: 2, parent: 1 }] })
  assert.deepEqual(fresh.ourConsumers, [])
  assert.deepEqual(fresh.theirConsumers, [1, 2])
})

test('回滚核对清单：说清要看什么，不写「应该好了」', async () => {
  const { rollbackChecklist } = await import('../scripts/switch-lib.mjs')
  const lines = rollbackChecklist({ lingcubPid: 53052, consumers: [{ pid: 1, parent: 0 }] })
  assert.match(lines.join('\n'), /没有 pid 53052/)
  assert.match(lines.join('\n'), /1 个 event consume/)
  assert.match(lines.join('\n'), /只能人来判/, '最后一条要明说机器判不了')
})
