import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openClaudeTerminal } from '../../../src/plugins/executor-claude-v2/terminal.ts'

const silent = (): void => {}

test('terminal：cscript 参数带 sessionId/cwd，等到 SessionStart 注册才返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-terminal-'))
  const sid = '12345678-aaaa-bbbb-cccc-123456789abc'
  let args: string[] = []
  let polls = 0
  await openClaudeTerminal({
    sessionId: sid,
    cwd: dir,
    sessionsDir: dir,
    timeoutMs: 1000,
    log: silent,
    tempDir: dir,
    deps: {
      platform: 'win32',
      exists: (p) => p.endsWith('launch-claude.vbs') || p === join(dir, `cc-launch-${sid.slice(0, 8)}.cmd`),
      run: async (o) => {
        args = [...o.args]
        writeFileSync(join(dir, `cc-launch-${sid.slice(0, 8)}.cmd`), '@echo off\n', 'utf8')
        return { code: 0, stdout: '', stderr: '' }
      },
      findPeer: () => {
        polls++
        return polls >= 2 ? { socket: 's', token: 't', pid: 1 } : null
      },
      sleep: async () => {},
    },
  })
  assert.equal(args[0], '//nologo')
  assert.equal(args[2], sid)
  assert.equal(args[3], dir)
  assert.equal(polls, 2)
})

test('terminal：等不到注册就失败，不假装 opened', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-terminal-timeout-'))
  await assert.rejects(
    () =>
      openClaudeTerminal({
        sessionId: 'abcdefgh-1',
        cwd: dir,
        sessionsDir: dir,
        timeoutMs: 20,
        log: silent,
        tempDir: dir,
        deps: {
          platform: 'win32',
          exists: () => true,
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          findPeer: () => null,
          sleep: async () => new Promise((r) => setTimeout(r, 5)),
        },
      }),
    /没有等到 Claude Code 会话注册/,
  )
})
