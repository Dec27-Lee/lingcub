import assert from 'node:assert/strict'
import { test } from 'node:test'


test('装钩子时清掉旧桥接留下的钩子，并且同一条命令只留一份', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')

  const dir = mkdtempSync(join(tmpdir(), 'lingcub-hooks-'))
  const file = join(dir, 'settings.json')
  // 老状态：旧桥接 5 条 + lingcub 已经装过 2 条（其中 Stop 重复了一份）
  writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node "E:/old/feishu-bridge-claude/a.js"' }] }],
        Stop: [
          { hooks: [{ type: 'command', command: 'node "E:/old/feishu-bridge-claude/notify.js"' }] },
          { hooks: [{ type: 'command', command: 'node "E:\\Develop_E\\lingcub\\dist\\main.js" hook post stop' }] },
          { hooks: [{ type: 'command', command: 'node "E:\\Develop_E\\lingcub\\dist\\main.js" hook post stop' }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }],
      },
    }),
  )

  const r = spawnSync(process.execPath, ['dist/main.js', 'hook', 'install', '--apply'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
  })
  assert.equal(r.status, 0, r.stderr)

  const j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as {
    hooks: Record<string, { hooks: { command?: string }[] }[]>
  }
  const all = JSON.stringify(j)
  assert.ok(!all.includes('feishu-bridge-claude'), '旧桥接的钩子要被清掉')
  assert.ok(all.includes('codegraph prompt-hook'), '别人的钩子不能碰')

  const stopCmds = (j.hooks['Stop'] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command))
  assert.equal(stopCmds.filter((c) => String(c).includes('lingcub')).length, 1, '同一条命令只留一份')
  for (const ev of ['SessionStart', 'PreToolUse', 'PermissionRequest', 'Notification']) {
    const cmds = (j.hooks[ev] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command))
    assert.ok(cmds.some((c) => String(c).includes('lingcub')), `${ev} 要装上 lingcub 的钩子`)
  }
})
