import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveContextWindow } from '../../../src/kernel/context-window.ts'
import { contextBar, statsLine } from '../../../src/kernel/transcript.ts'

/** 造一份假的 `~/.claude/settings.json`（真机那份由 CC Switch 整体覆盖）。 */
function settingsFile(env: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-ctx-'))
  const p = join(dir, 'settings.json')
  writeFileSync(p, JSON.stringify({ env }))
  return p
}

test('分母取 claude 自己声明的窗口，不取配置里的常量', () => {
  const path = settingsFile({
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
  })
  assert.equal(
    resolveContextWindow(200_000, {}, path),
    500_000,
    '自动压缩线（终端状态栏的分母）优先于模型硬上限',
  )
  // 用户报的那张卡：245k 被 200k 除成 122% → 满格 100%，实际是 49%
  assert.equal(contextBar(245_000, resolveContextWindow(200_000, {}, path)), '█░░░ 49%')
  assert.equal(contextBar(245_000, 200_000), '████ 100%', '旧分母常量算出来的样子（回归守卫）')
})

test('钩子进程继承的 env 优先于 settings.json', () => {
  const path = settingsFile({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' })
  assert.equal(
    resolveContextWindow(0, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' }, path),
    200_000,
    '钩子是 claude 拉起的子进程，它手里的 env 就是这个窗口的真值',
  )
})

test('拿不到分母就不画百分比，也不拿配置的 0 当真', () => {
  const path = settingsFile({})
  assert.equal(resolveContextWindow(0, {}, path), undefined)
  assert.equal(resolveContextWindow(undefined, {}, path), undefined)
  assert.equal(contextBar(245_000, undefined), '')
})

test('配置文件显式写了才用它兜底', () => {
  const path = settingsFile({})
  assert.equal(resolveContextWindow(200_000, {}, path), 200_000)
})

test('statsLine：有分母画条，没分母只写 token 数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-tx-'))
  const f = join(dir, 'session.jsonl')
  writeFileSync(
    f,
    `${JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: 419, cache_read_input_tokens: 260_581, cache_creation_input_tokens: 0, output_tokens: 527 },
      },
    })}\n`,
  )
  // 261283 / 500000 = 52.3% → 52%，floor 给 2 格
  assert.equal(statsLine(f, 500_000), '██░░ 52% 261k · Tokens 946')
  assert.equal(statsLine(f, undefined), '261k · Tokens 946')
})
