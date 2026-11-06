#!/usr/bin/env node
// 文档规范自检：链接可达、台账字段齐全、索引行合规。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const errs = []
const rel = (p) => p.replace(ROOT + '\\', '').replace(ROOT + '/', '')

function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, '')
}

function links(file) {
  const text = stripFences(readFileSync(file, 'utf8'))
  const base = dirname(file)
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = m[1].split('#')[0]
    if (!href || /^https?:|^mailto:/.test(href)) continue
    if (!existsSync(resolve(base, href))) errs.push(`${rel(file)}: 链接失效 → ${href}`)
  }
}

function taskDocs() {
  const dir = join(ROOT, 'docs/tasks')
  const out = []
  for (const y of readdirSync(dir, { withFileTypes: true })) {
    if (!y.isDirectory() || !/^\d{6}$/.test(y.name)) continue
    for (const f of readdirSync(join(dir, y.name))) {
      if (f.endsWith('.md')) out.push(join(dir, y.name, f))
    }
  }
  return out
}

const FIELDS = ['任务 ID', '任务名', '创建人', '创建时间', '最后更新人', '更新时间', '相关材料']
const ID_RE = /^(\d{8}-[a-z0-9]+-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})$/
const FILE_ID_RE = /^(\d{8}-[a-z0-9]+-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})-/

// 1 链接可达
for (const f of ['README.md', 'AGENTS.md', 'CHANGELOG.md', 'docs/README.md', 'docs/tasks/README.md', 'docs/tasks/INDEX.md']) {
  if (!existsSync(join(ROOT, f))) errs.push(`缺少 ${f}`)
  else links(join(ROOT, f))
}

// 2 索引行
const idxPath = join(ROOT, 'docs/tasks/INDEX.md')
const idx = readFileSync(idxPath, 'utf8')
let rows = 0
for (const line of idx.split('\n')) {
  if (!/^\|\s*\d{8}-/.test(line)) continue
  rows++
  const c = line.split('|').map((s) => s.trim())
  if (c.length !== 8) { errs.push(`INDEX 行列数异常（${c.length - 2} 列）：${c[1]}`); continue }
  const [, id, , , , doc, summary] = c
  if (!ID_RE.test(id)) errs.push(`INDEX 任务 ID 不合规：${id}`)
  const m = doc.match(/\[文档\]\(([^)]+)\)/)
  if (!m || !existsSync(resolve(join(ROOT, 'docs/tasks'), m[1]))) errs.push(`INDEX ${id}: 相关文档不可达`)
  if (summary.length > 150) errs.push(`INDEX ${id}: 概述 ${summary.length} 字 > 150`)
}
if (rows === 0) errs.push('INDEX 没有任何任务行')

// 3 任务文档头部
const docs = taskDocs()
for (const f of docs) {
  const text = readFileSync(f, 'utf8')
  const base = f.slice(f.lastIndexOf('\\') + 1)
  const m = base.match(FILE_ID_RE)
  if (!m) { errs.push(`${rel(f)}: 文件名不符合 YYYYMMDD-作者-随机码-任务名.md`); continue }
  const id = m[1]
  if (!text.startsWith(`# ${id} `)) errs.push(`${rel(f)}: 标题未以「# ${id} 」开头`)
  for (const k of FIELDS) if (!text.includes(`**${k}**`)) errs.push(`${rel(f)}: 缺字段 ${k}`)
  if (!text.includes(`**任务 ID**：${id}`)) errs.push(`${rel(f)}: 任务 ID 与文件名不一致`)
  if (!/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) errs.push(`${rel(f)}: 时间格式不合规`)
}

// 4 规则单一来源
const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
if (!agents.includes('docs/tasks/README.md')) errs.push('AGENTS.md 未链接台账规范')
// 台账触发规则只在该节内校验：路由到 docs/README.md、用索引判断、动手前先写文档
const ledgerSection = (agents.match(/## 任务台账[\s\S]*?(?=\n## )/) || [''])[0]
if (!ledgerSection) errs.push('AGENTS.md 缺「任务台账」节')
const ledgerMissing = ['docs/README.md', 'docs/tasks/INDEX.md', '写第一行代码前'].filter(
  (s) => !ledgerSection.includes(s),
)
if (ledgerMissing.length) errs.push(`AGENTS.md 缺台账触发规则（缺：${ledgerMissing.join('、')}）`)
if (agents.includes('23456789ABCDEFGHJKLMNPQRSTUVWXYZ')) errs.push('AGENTS.md 重复抄写了台账细则（应只放链接）')

// 5 台账与任务文档一一对应
if (rows !== docs.length) errs.push(`INDEX 有 ${rows} 行，任务文档有 ${docs.length} 份，应一一对应`)

if (errs.length) {
  console.error(`✖ 文档自检失败（${errs.length} 处）`)
  for (const e of errs) console.error('  ' + e)
  process.exit(1)
}
console.log(`✔ 文档自检通过：链接可达、${rows} 行台账合规、${taskDocs().length} 份任务文档字段齐全、规则单一来源`)
