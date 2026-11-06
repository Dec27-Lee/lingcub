#!/usr/bin/env node
/**
 * 切换前自检（只读，不启停任何东西）。
 *
 * 它只回答一个问题：现在按下「切」会发生什么？
 * 每一项都给出「过了/没过/提醒」，没过的必须说清怎么补，不猜。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const MARK = '"@yue/lingcub"'
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

function findRoot(start) {
  let dir = start
  for (;;) {
    const pkg = resolve(dir, 'package.json')
    if (existsSync(pkg) && readFileSync(pkg, 'utf8').includes(MARK)) return dir
    const up = resolve(dir, '..')
    if (up === dir) throw new Error('找不到项目根')
    dir = up
  }
}

const root = findRoot(process.cwd())

// 1) 构建产物
check('dist 构建产物', existsSync(join(root, 'dist/main.js')), 'dist/main.js 存在（否则先 pnpm build）')

// 2) 配置能通过校验
try {
  // doctor 把结论打到 stderr（日志统一走 stderr），所以要一起看
  const r = spawnSync(process.execPath, [join(root, 'dist/main.js'), 'doctor'], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  check('配置与插件装配', r.status === 0 && /doctor 通过/.test(out), r.status === 0 ? 'doctor 通过' : 'doctor 未通过')
} catch (e) {
  check('配置与插件装配', false, `doctor 失败：${String(e.stderr ?? e.message).trim().split('\n').slice(-1)[0]}`)
}

// 3) 钩子装没装（没装 → 结果回传与选择题都不会发生）
const settingsFile = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json')
let hooksOk = false
let hooksDetail = `${settingsFile} 不存在或没有我们的钩子（跑 lingcub hook install --apply）`
if (existsSync(settingsFile)) {
  try {
    const raw = readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, '')
    const s = JSON.parse(raw)
    const all = JSON.stringify(s.hooks ?? {})
    const mine = (all.match(/lingcub/g) ?? []).length
    hooksOk = mine > 0
    hooksDetail = hooksOk ? `已装（引用 lingcub 共 ${mine} 处）` : hooksDetail
  } catch (e) {
    hooksDetail = `settings.json 解析失败：${e.message}`
  }
}
check('claude 钩子', hooksOk, hooksDetail)

// 4) 运行档位（observe 档不会真的开窗）
let mode = '未知'
try {
  const base = readFileSync(join(root, 'config/lingcub.yaml'), 'utf8')
  const overlayFile = join(root, 'data/local.json')
  const overlay = existsSync(overlayFile) ? JSON.parse(readFileSync(overlayFile, 'utf8')) : {}
  mode = overlay.mode ?? (base.match(/^mode:\s*(\w+)/m)?.[1] ?? '未知')
} catch {
  /* 交给上面 doctor 报 */
}
check('运行档位', mode !== 'observe', `当前 mode=${mode}（observe 只记录，不会真的开窗）`)

// 5) 开窗档是否打开（否则群里说话不会开窗）
//    两条路都算：bus 档走场景的 openOnMessage（现行），旧 Pipeline 档走 sessions.newTopicPolicy=open。
let openOnMessage = false
let policy = 'judge'
try {
  const overlayFile = join(root, 'data/local.json')
  const overlay = existsSync(overlayFile) ? JSON.parse(readFileSync(overlayFile, 'utf8')) : {}
  openOnMessage = overlay.scenarios?.console?.openOnMessage === true
  policy = overlay.sessions?.newTopicPolicy ?? 'judge'
} catch {
  /* 同上 */
}
check(
  '开窗档',
  openOnMessage || policy === 'open',
  openOnMessage
    ? 'scenarios.console.openOnMessage=true（群消息即开窗，走 v2 场景）'
    : policy === 'open'
      ? 'sessions.newTopicPolicy=open（旧 Pipeline 开窗）'
      : '两条开窗路都没开：scenarios.console.openOnMessage 或 sessions.newTopicPolicy=open 至少开一个',
)

// 6) claude 会话目录可读（投递要靠它找活管道）
const sessionsDir = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions')
const sessionCount = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).length : 0
check('claude 会话表', existsSync(sessionsDir), `${sessionsDir}（现有 ${sessionCount} 个会话登记）`)

// 7) 有没有别的消费者占着同一个订阅
let consumers = []
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'event consume' } | Select-Object -ExpandProperty ProcessId"],
  { encoding: 'utf8' })
  consumers = out.split('\n').map((s) => s.trim()).filter(Boolean)
} catch {
  /* 查不到就当查不到，不阻塞 */
}
check('订阅占用', consumers.length === 0, consumers.length ? `已有消费者在跑（pid ${consumers.join(', ')}），切换前必须先停` : '没有别的消费者')

// 8) 本地数据目录
check('数据目录', existsSync(join(root, 'data')), 'data/ 存在（首次运行会自动建）')

// 对齐表自审：docs/005 第 5 节写着「已实现」的每一条，代码里必须有对应落点
try {
  const r = spawnSync(process.execPath, [join(root, 'scripts/audit-parity.mjs')], { encoding: 'utf8' })
  const tail = (r.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('落点核对') || l.startsWith('测试踪迹'))
  check('能力对齐自审', r.status === 0, tail.join('；') || '自审脚本没输出')
} catch (e) {
  check('能力对齐自审', false, `跑不起来：${e instanceof Error ? e.message : String(e)}`)
}

const bad = results.filter((r) => !r.ok)
for (const r of results) process.stdout.write(`${r.ok ? '✔' : '✘'} ${r.name}：${r.detail}\n`)
process.stdout.write(`\n${bad.length ? `未就绪 ${bad.length} 项：${bad.map((r) => r.name).join('、')}` : '全部就绪，可以切换'}\n`)
process.exitCode = bad.length ? 1 : 0
