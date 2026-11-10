import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dropInternalSessions,
  firstSessionId,
  internalArgs,
  isOneShotEntrypoint,
  isInternalClaudeSession,
  keepUserWindows,
  looksLikeClaude,
  markInternalClaudeSession,
  runClaudeOnce,
  setSpawnRecorder,
} from '../../../src/plugin-kit/internal-claude.ts'
import { purgeSpawnFiles } from '../../../src/plugin-kit/internal-session-files.ts'

test('claude 二进制识别：`.cmd` 壳和绝对路径也算，dsh 不算', () => {
  for (const b of ['claude', 'claude.exe', 'C:\\Users\\Yue\\AppData\\Roaming\\npm\\claude.cmd', '/usr/local/bin/claude']) {
    assert.equal(looksLikeClaude(b), true, b)
  }
  for (const b of ['dsh', 'dsh.exe', 'node', 'claude-code']) {
    assert.equal(looksLikeClaude(b), false, b)
  }
})

test('一次性调用带上 --session-id，并登记为平台内部会话', () => {
  const args = internalArgs(['-p', '--output-format', 'text'], 'sid-1')
  assert.deepEqual(args.slice(-2), ['--session-id', 'sid-1'])
  assert.equal(isInternalClaudeSession('sid-1'), true)
})

test('已有 --session-id 时原样保留，不重复注入也不登记', () => {
  const args = internalArgs(['-p', '--session-id', 'given'], 'sid-2')
  assert.deepEqual(args, ['-p', '--session-id', 'given'])
  assert.equal(isInternalClaudeSession('sid-2'), false)
})

test('活会话列举剔掉平台自己的分析子进程，保留用户窗口', () => {
  markInternalClaudeSession('internal-1')
  const list = [
    { sessionId: 'internal-1', cwd: 'E:\\Develop_E\\lingcub' },
    { sessionId: 'user-window', cwd: 'E:\\Develop_E\\tt' },
  ]
  assert.deepEqual(
    dropInternalSessions(list).map((s) => s.sessionId),
    ['user-window'],
  )
})

test('一次性调用的入口标记：sdk-cli 不算用户窗口，cli / 空都算', () => {
  assert.equal(isOneShotEntrypoint('sdk-cli'), true)
  assert.equal(isOneShotEntrypoint('cli'), false)
  assert.equal(isOneShotEntrypoint(undefined), false)
  assert.equal(isOneShotEntrypoint(''), false)
})

test('只保留用户窗口：内存登记与一次性调用都要剔掉，认不出的不误杀', () => {
  markInternalClaudeSession('mem-1')
  const list = [
    { sessionId: 'mem-1', entrypoint: 'cli' },
    { sessionId: 'oneshot-1', entrypoint: 'sdk-cli' },
    { sessionId: 'user-1', entrypoint: 'cli' },
    { sessionId: 'unknown-1', entrypoint: undefined },
  ]
  assert.deepEqual(
    keepUserWindows(list).map((s) => s.sessionId),
    ['user-1', 'unknown-1'],
  )
})

test('dsh 的会话 id 只能从输出首行读：`{"type":"session","sessionId":…}`', () => {
  const out = [
    JSON.stringify({ type: 'session', sessionId: 'session-abc', cwd: 'E:\\x' }),
    JSON.stringify({ type: 'final', text: 'ok' }),
  ].join('\n')
  assert.equal(firstSessionId(out), 'session-abc')
  // claude 的纯文本输出没有这一段
  assert.equal(firstSessionId('就是一段话\n没有 JSON'), undefined)
  // 别的 JSON 行不该被当成会话 id
  assert.equal(firstSessionId(JSON.stringify({ type: 'final', sessionId: 'x' })), undefined)
})

test('清理按 id 删转录：只删清单里的，别的文件一个不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-spawn-'))
  const projects = join(root, 'projects')
  const dshRoot = join(root, 'dsh')
  for (const [dir, name] of [
    ['E--Develop-E-lingcub', 'ours-1.jsonl'],
    ['E--Develop-E-lingcub', 'user-keep.jsonl'],
    ['E--Develop-E-tt', 'ours-2.jsonl'],
  ] as const) {
    mkdirSync(join(projects, dir), { recursive: true })
    writeFileSync(join(projects, dir, name), '{}\n')
  }
  mkdirSync(join(dshRoot, 'slug-a', 'session-ours'), { recursive: true })
  writeFileSync(join(dshRoot, 'slug-a', 'session-ours', 'session.v4.jsonl.zstd'), 'x')
  mkdirSync(join(dshRoot, 'slug-a', 'session-user'), { recursive: true })

  const r = purgeSpawnFiles(
    [
      { sessionId: 'ours-1', executor: 'claude' },
      { sessionId: 'ours-2', executor: 'claude' },
      { sessionId: 'session-ours', executor: 'dsh' },
      { sessionId: 'gone-already', executor: 'claude' },
    ],
    { claudeProjectsDir: projects, dshSessionsDir: dshRoot },
  )

  assert.deepEqual(r.removed.sort(), ['ours-1', 'ours-2', 'session-ours'].sort())
  assert.deepEqual(r.missing, ['gone-already'], '文件本来就不在的算 missing，不报错')
  assert.deepEqual(r.failed, [])
  assert.deepEqual(readdirSync(join(projects, 'E--Develop-E-lingcub')), ['user-keep.jsonl'], '用户自己的转录不能动')
  assert.deepEqual(readdirSync(join(dshRoot, 'slug-a')).sort(), ['session-user'].sort(), '别的 dsh 会话不能动')
})

test('非 claude 二进制（dsh）：跑完把输出里的会话 id 交给注入的 recorder', async () => {
  const seen: { sessionId: string; executor: string; purpose: string }[] = []
  setSpawnRecorder((rec) => seen.push(rec))
  try {
    const r = await runClaudeOnce({
      binary: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({type:"session",sessionId:"session-xyz"}))'],
      purpose: 'classify',
    })
    assert.equal(r.code, 0)
    assert.deepEqual(seen, [{ sessionId: 'session-xyz', executor: 'dsh', purpose: 'classify' }])
  } finally {
    setSpawnRecorder(null)
  }
})
