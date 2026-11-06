import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'

const ROOT = resolve(import.meta.dirname, '..')
const PLUGINS = resolve(ROOT, 'src/plugins')
const DOMAIN = resolve(ROOT, 'src/domain')
const KIT = resolve(ROOT, 'src/plugin-kit')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
}

test('插件边界：只允许 domain、plugin-kit、自身目录和 npm 包', () => {
  const problems: string[] = []
  for (const file of walk(PLUGINS)) {
    const own = resolve(file, '..')
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) continue // npm / node
      const target = resolve(own, spec)
      const rel = relative(ROOT, target).split(sep).join('/')
      if (rel.startsWith('src/domain/') || rel === 'src/domain' || rel.startsWith('src/plugin-kit/')) continue
      // 自身插件目录（含子目录）
      if (target === own || target.startsWith(own + sep)) continue
      // 明确禁止的理由，方便报错时定位
      if (rel.startsWith('src/kernel/') || rel.startsWith('src/routing/')) {
        problems.push(`${relative(ROOT, file)} → ${rel}（插件不能 import 内核/路由）`)
      } else if (rel.startsWith('src/plugins/')) {
        problems.push(`${relative(ROOT, file)} → ${rel}（插件不能 import 其他插件）`)
      } else {
        problems.push(`${relative(ROOT, file)} → ${rel}（不在允许边界）`)
      }
    }
  }
  assert.deepEqual(problems, [])
})
