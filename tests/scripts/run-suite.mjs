#!/usr/bin/env node
// 单元测试 runner：按 tests/scenarios/*/suite.yaml 选择场景并执行，产物落 tests/out/<runId>/。
// 规范见 tests/README.md。不引入测试框架：每个场景仍然是 `node --test <file>`。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import YAML from 'yaml'

const ROOT = resolve(import.meta.dirname, '../..')
const SCENARIOS = join(ROOT, 'tests/scenarios')
const SPECS = join(ROOT, 'tests/specs')

const argv = process.argv.slice(2)
const values = (name) =>
  argv.filter((a) => a.startsWith(`--${name}=`)).flatMap((a) => a.slice(name.length + 3).split(',').map((v) => v.trim()).filter(Boolean))
const flag = (name) => argv.includes(`--${name}`)

const filters = {
  suite: values('suite'),
  case: values('case'),
  tag: values('tag'),
  priority: values('priority'),
  layer: values('layer'),
  status: values('status'),
}

function fail(msg, code = 2) {
  console.error(msg)
  process.exitCode = code
}

// 1. 读全部套件
const suites = []
for (const d of readdirSync(SCENARIOS, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  const file = join(SCENARIOS, d.name, 'suite.yaml')
  if (!existsSync(file)) {
    fail(`✖ ${d.name}: 缺少 suite.yaml（域目录必须同时有 case.md 与 suite.yaml）`)
    continue
  }
  const doc = YAML.parse(readFileSync(file, 'utf8'))
  if (doc?.suite !== d.name || doc?.domain !== d.name) {
    fail(`✖ ${d.name}/suite.yaml: suite/domain 必须等于目录名（实际 ${doc?.suite}/${doc?.domain}）`)
    continue
  }
  if (!existsSync(join(SCENARIOS, d.name, 'case.md'))) fail(`✖ ${d.name}: 缺少 case.md（人工评审入口）`)
  for (const s of doc.scenarios ?? []) suites.push({ ...s, suite: d.name })
}

// 2. 登记完整性：specs 下每个用例文件都必须在某份 suite.yaml 里，反之文件必须存在
const registered = new Map(suites.map((s) => [s.file, s]))
const onDisk = []
for (const d of readdirSync(SPECS, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  for (const f of readdirSync(join(SPECS, d.name))) {
    if (f.endsWith('.test.ts')) onDisk.push(`tests/specs/${d.name}/${f}`)
  }
}
const unregistered = onDisk.filter((f) => !registered.has(f))
const missing = suites.filter((s) => !existsSync(join(ROOT, s.file))).map((s) => `${s.id} → ${s.file}`)
const idSeen = new Set()
for (const s of suites) {
  if (idSeen.has(s.id)) fail(`✖ 场景 ID 重复：${s.id}`)
  idSeen.add(s.id)
}
if (unregistered.length) fail(`✖ 有 ${unregistered.length} 个用例文件未登记到 suite.yaml：\n  ${unregistered.join('\n  ')}`)
if (missing.length) fail(`✖ suite.yaml 指向的文件不存在：\n  ${missing.join('\n  ')}`)
if (process.exitCode) process.exit()

// 3. 筛选
const match = (s) =>
  (!filters.suite.length || filters.suite.includes(s.suite)) &&
  (!filters.case.length || filters.case.includes(s.id)) &&
  (!filters.priority.length || filters.priority.includes(s.priority)) &&
  (!filters.layer.length || filters.layer.includes(s.layer)) &&
  (!filters.status.length || filters.status.includes(s.status)) &&
  (!filters.tag.length || filters.tag.some((t) => (s.tags ?? []).includes(t)))
const selected = suites.filter(match)
// status=gated/pending 默认不跑（规范 §4）；显式 --status= 时按用户的来
const runnable = filters.status.length ? selected : selected.filter((s) => s.status === 'ready')
const skippedStatus = selected.filter((s) => !runnable.includes(s))

if (flag('list') || flag('check')) {
  if (!flag('check')) {
    console.log(`共 ${suites.length} 条场景，命中 ${selected.length} 条\n`)
    const pad = (v, n) => String(v ?? '').padEnd(n)
    console.log(`${pad('场景 ID', 18)}${pad('层级', 12)}${pad('优先级', 8)}${pad('状态', 8)}${pad('断言', 5)}用例文件`)
    for (const s of selected) console.log(`${pad(s.id, 18)}${pad(s.layer, 12)}${pad(s.priority, 8)}${pad(s.status, 8)}${pad((s.assertions ?? []).length, 5)}${s.file}`)
  }
  if (flag('check')) console.log(`✓ 登记完整：${suites.length} 条场景 / ${onDisk.length} 个用例文件，case.md 与 suite.yaml 齐全`)
  process.exit()
}

if (skippedStatus.length) {
  console.log(`跳过 ${skippedStatus.length} 条非 ready 场景（${[...new Set(skippedStatus.map((s) => s.status))].join('/')}）：${skippedStatus.map((s) => s.id).join(', ')}\n`)
}
if (!runnable.length) {
  fail('✖ 筛选条件没有命中任何场景（用 --list 看清单）')
  process.exit()
}

// 4. 执行
const stamp = new Date()
const p = (n) => String(n).padStart(2, '0')
const runId = `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`
const outDir = join(ROOT, 'tests/out', runId)
mkdirSync(outDir, { recursive: true })

const junit = flag('junit')
const jobs = Math.max(1, Number(values('jobs')[0] ?? 4) || 4)

function runOne(s) {
  return new Promise((done) => {
    const started = Date.now()
    const logPath = join(outDir, `${s.id}.log`)
    const args = ['--experimental-strip-types', '--test']
    if (junit) {
      args.push('--test-reporter=junit', `--test-reporter-destination=${join(outDir, `${s.id}.junit.xml`)}`, '--test-reporter=spec', '--test-reporter-destination=stdout')
    }
    args.push(s.file)
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, (s.timeoutSec ?? 60) * 1000)
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (out += b))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) out += `\n[runner] 超过 timeoutSec=${s.timeoutSec ?? 60}s，已终止\n`
      writeFileSync(logPath, out, 'utf8')
      const durationMs = Date.now() - started
      const exitCode = timedOut ? 124 : code
      const ok = exitCode === 0
      const mark = ok ? '✔' : '✖'
      console.log(`${mark} ${s.id} ${s.priority} ${s.file.replace('tests/specs/', '')} (${durationMs}ms)`)
      if (!ok) {
        const tail = out.trim().split('\n').slice(-12).join('\n')
        console.log(tail.replace(/^/gm, '    '))
      }
      done({ id: s.id, suite: s.suite, file: s.file, layer: s.layer, priority: s.priority, status: s.status, exitCode, timedOut, durationMs, log: `tests/out/${runId}/${s.id}.log` })
    })
  })
}

async function pool(items, n, worker) {
  const results = new Array(items.length)
  let i = 0
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      results[idx] = await worker(items[idx])
    }
  })
  await Promise.all(runners)
  return results
}

console.log(`runId=${runId} 场景=${runnable.length} 并发=${jobs}${junit ? ' junit=on' : ''}\n`)
const cases = await pool(runnable, jobs, runOne)
const passed = cases.filter((c) => c.exitCode === 0)
const failed = cases.filter((c) => c.exitCode !== 0)

const summary = {
  runId,
  startedAt: stamp.toISOString(),
  finishedAt: new Date().toISOString(),
  command: `node tests/scripts/run-suite.mjs ${argv.join(' ')}`.trim(),
  filters,
  totals: { scenarios: cases.length, passed: passed.length, failed: failed.length, durationMs: cases.reduce((a, c) => a + c.durationMs, 0) },
  cases,
}
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

if (junit) {
  const parts = []
  for (const c of cases) {
    const f = join(outDir, `${c.id}.junit.xml`)
    if (!existsSync(f)) continue
    // node --test 的 junit reporter 只输出 <testsuites> 容器，这里给每条场景补一层 <testsuite>
    const inner = readFileSync(f, 'utf8')
      .replace(/^<\?xml[^>]*\?>\s*/, '')
      .replace(/<\/?testsuites[^>]*>/g, '')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('<!--'))
      .map((l) => `    ${l.trim()}`)
      .join('\n')
    const tests = (inner.match(/<testcase/g) ?? []).length
    const failures = (inner.match(/<failure/g) ?? []).length
    parts.push(`  <testsuite name="${c.id}" file="${c.file}" tests="${tests}" failures="${failures}" errors="0" skipped="0">\n${inner}\n  </testsuite>`)
  }
  writeFileSync(join(outDir, 'junit.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${parts.join('\n')}\n</testsuites>\n`, 'utf8')
}

console.log(`\n通过 ${passed.length}/${cases.length}，失败 ${failed.length}；产物 tests/out/${runId}/`)
if (failed.length) {
  console.log(`失败场景：${failed.map((c) => c.id).join(', ')}`)
  process.exitCode = 1
}
