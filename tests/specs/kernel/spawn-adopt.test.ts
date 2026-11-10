import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanSpawnTranscripts, TASK_MARKERS, totalBytes } from '../../../src/kernel/spawn-adopt.ts'

function project(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-adopt-'))
  for (const [slug, names] of Object.entries(files)) {
    mkdirSync(join(root, slug), { recursive: true })
    for (const name of names) {
      const body = name.includes('sdk-ours')
        ? JSON.stringify({ type: 'queue-operation', entrypoint: 'sdk-cli', content: `${TASK_MARKERS[1]}\n发送人：张三` })
          : name.includes('sdk-probe')
            ? JSON.stringify({ type: 'queue-operation', entrypoint: 'sdk-cli', content: '只输出 JSON：{"summary":"ok"}' })
          : name.includes('interactive')
            ? JSON.stringify({ type: 'user', entrypoint: 'cli', message: { content: '帮我看看' } })
            : JSON.stringify({ type: 'user', message: { content: '旧格式' } })
      writeFileSync(join(root, slug, name), `${body}\n`)
    }
  }
  return root
}

test('导入清单只认「sdk-cli + 本平台任务模板」：探针、交互式会话、旧格式都不进', () => {
  const root = project({
    'E--Develop-E-lingcub': ['sdk-ours-1.jsonl', 'sdk-probe-1.jsonl', 'interactive-1.jsonl', 'legacy-1.jsonl'],
    'E--Develop-E-tt': ['sdk-ours-2.jsonl'],
  })
  const scan = scanSpawnTranscripts(root)
  assert.deepEqual(
    scan.adopt.map((c) => c.sessionId).sort(),
    ['sdk-ours-1', 'sdk-ours-2'],
    '两个目录里的都认，判据不依赖目录名',
  )
  assert.deepEqual(
    scan.sdkCliUnmarked.map((c) => c.sessionId),
    ['sdk-probe-1'],
    'sdk-cli 但没模板 = 手工探针，不动',
  )
  assert.deepEqual(
    scan.interactive.map((c) => c.sessionId),
    ['interactive-1'],
    'entrypoint=cli 是用户自己开的窗口',
  )
  assert.deepEqual(
    scan.unknown.map((c) => c.sessionId),
    ['legacy-1'],
    '没有 entrypoint 的认不出来，不动',
  )
  assert.ok(totalBytes(scan.adopt) > 0)
})

test('扫描是纯读：跑完九个文件一个不少，内容也没变', () => {
  const root = project({ 'E--Develop-E-lingcub': ['sdk-ours-1.jsonl', 'interactive-1.jsonl'] })
  const before = scanSpawnTranscripts(root)
  const again = scanSpawnTranscripts(root)
  assert.deepEqual(again.adopt, before.adopt)
  assert.deepEqual(again.interactive, before.interactive)
})

test('目录不存在时返回空清单，不抛错', () => {
  const scan = scanSpawnTranscripts(join(tmpdir(), 'lingcub-not-exist-xyz'))
  assert.deepEqual(scan, { adopt: [], sdkCliUnmarked: [], interactive: [], unknown: [] })
})
