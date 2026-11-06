import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveCommand, runOnce } from '../src/plugin-kit/spawn.ts'

test('Windows 上 npm 全局壳要解析成真实目标，否则 spawn 直接 ENOENT', () => {
  const r = resolveCommand('lark-cli')
  if (process.platform === 'win32') {
    assert.notEqual(r.binary, 'lark-cli', '不能原样返回 .cmd 壳的名字')
    assert.ok(existsSync(r.binary), `解析出来的目标必须真实存在：${r.binary}`)
    assert.match(r.binary, /(node\.exe|\.exe)$/i)
  } else {
    assert.deepEqual(r, { binary: 'lark-cli', prefixArgs: [] })
  }
})

test('解析出的命令真能跑（不是只解析得对）', { timeout: 30_000 }, async () => {
  if (process.platform !== 'win32') return
  const r = await runOnce({ binary: 'lark-cli', args: ['--version'], timeoutMs: 20_000 })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /lark-cli version/i)
})

test('壳的形状：指向 exe 的直接用 exe，指向 js 的用当前 node', () => {
  if (process.platform !== 'win32') return
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-shim-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })

  // 形状一：真 exe（claude 就是这样）
  writeFileSync(join(binDir, 'fake-exe.cmd'), '@ECHO off\r\n"%dp0%\\tool\\app.exe"   %*\r\n')
  // 形状二：node + js（npm 的通用形状，注意壳里也会出现 node.exe 字样）
  writeFileSync(
    join(binDir, 'fake-js.cmd'),
    '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & "%_prog%"  "%dp0%\\pkg\\run.js" %*\r\n',
  )

  const oldPath = process.env.PATH
  process.env.PATH = `${binDir};${oldPath}`
  try {
    // 清缓存：同一进程里可能已解析过同名命令
    const exe = resolveCommand('fake-exe')
    assert.match(exe.binary, /app\.exe$/)
    assert.deepEqual(exe.prefixArgs, [])

    const js = resolveCommand('fake-js')
    assert.equal(js.binary, process.execPath, 'js 形状要用当前 node 跑，不能误认壳里的 node.exe')
    assert.match(js.prefixArgs[0] ?? '', /run\.js$/)
  } finally {
    process.env.PATH = oldPath
  }
})
