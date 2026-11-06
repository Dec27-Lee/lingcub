import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeClaudeWindow } from '../src/plugin-kit/claude-window.ts'
import { openClaudeTerminal } from '../src/plugins/executor-claude-v2/terminal.ts'

const silent = (): void => {}

test('收窗：按 cc-launch-<前8位> 找到根进程，带 /T 连子孙一起关', async () => {
  const calls: { bin: string; args: string[] }[] = []
  const fakeRun = async (o: { binary: string; args?: string[] }) => {
    calls.push({ bin: o.binary, args: o.args ?? [] })
    if (o.binary === 'powershell.exe') return { code: 0, stdout: '40932\r\n41000\r\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const closed = await closeClaudeWindow('c41a0e34-ef10-4000-8000-000000000000', {
    run: fakeRun as never,
    platform: 'win32',
  })
  assert.equal(closed, 2)
  const find = calls[0]?.args.join(' ') ?? ''
  assert.match(find, /cc-launch-c41a0e34/, '要按启动脚本名找进程')
  assert.doesNotMatch(find, /c41a0e34-ef10/, '只用前 8 位，跟脚本名一致')
  assert.deepEqual(
    calls.slice(1).map((c) => `${c.bin} ${c.args.join(' ')}`),
    ['taskkill /PID 40932 /T /F', 'taskkill /PID 41000 /T /F'],
    '每个进程都要 /T 连子孙',
  )
})

test('收窗：没找到进程就返回 0（窗口可能已经自己退了）', async () => {
  const fakeRun = async () => ({ code: 0, stdout: '', stderr: '' })
  assert.equal(await closeClaudeWindow('deadbeef', { run: fakeRun as never, platform: 'win32' }), 0)
})

test('收窗：非 Windows 直接返回 0，不执行任何命令', async () => {
  let called = 0
  const fakeRun = async () => {
    called++
    return { code: 0, stdout: '', stderr: '' }
  }
  assert.equal(await closeClaudeWindow('abcdef12', { run: fakeRun as never, platform: 'darwin' }), 0)
  assert.equal(called, 0)
})

test('开窗超时：会先收窗再报错，错误里说明可能是信任确认框', async () => {
  const closedIds: string[] = []
  await assert.rejects(
    () =>
      openClaudeTerminal({
        sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
        cwd: 'E:\\Develop_E\\lingcub',
        sessionsDir: 'C:\\tmp\\no-such-sessions',
        timeoutMs: 30,
        log: silent,
        deps: {
          platform: 'win32',
          exists: () => true,
          run: (async () => ({ code: 0, stdout: '', stderr: '' })) as never,
          findPeer: () => null,
          sleep: async () => {},
        },
        closeWindow: async (id) => {
          closedIds.push(id)
          return 1
        },
      }),
    (e: Error) => /没有等到 Claude Code 会话注册/.test(e.message) && /确认框/.test(e.message),
  )
  assert.deepEqual(closedIds, ['aaaaaaaa-1111-2222-3333-444444444444'], '超时必须收窗')
})
