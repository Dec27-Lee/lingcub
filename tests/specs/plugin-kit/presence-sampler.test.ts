import assert from 'node:assert/strict'
import { test } from 'node:test'
import { idleScript, startPresenceSampler } from '../../../src/plugin-kit/presence-sampler.ts'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('在场采样脚本：here-string 必须顶格（缩进会让整段 PowerShell 解析失败）', () => {
  const s = idleScript(2000)
  assert.match(s, /GetLastInputInfo/, '要真的问系统最后输入时间')
  assert.match(s, /Start-Sleep -Milliseconds 2000/)
  // 结尾的 '@ 必须在行首：前面有一个空格，PowerShell 就报「字符串缺少终止符」
  const lines = s.split('\n')
  const end = lines.findIndex((l) => l === "'@")
  assert.ok(end > 0, "结尾必须是顶格的 '@")
  assert.equal(lines[0]?.trimEnd(), "Add-Type -TypeDefinition @'")
})

test('在场采样：真跑一次 PowerShell，写出 idleMs 与时间戳', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-presence-'))
  const file = join(dir, 'presence.json')
  const sampler = startPresenceSampler({ file, intervalMs: 500, log: () => {} })
  try {
    if (process.platform !== 'win32') return
    // 首个采样要等 PowerShell 起来（冷启动约 1-2 秒）
    for (let i = 0; i < 30; i++) {
      if (existsSync(file)) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.ok(existsSync(file), '采样文件应该被写出来')
    const v = JSON.parse(readFileSync(file, 'utf8')) as { idleMs: number; at: string }
    assert.equal(typeof v.idleMs, 'number')
    assert.ok(v.idleMs >= 0)
    assert.ok(Number.isFinite(Date.parse(v.at)))
  } finally {
    await sampler.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
