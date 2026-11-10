import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isPresent, presencePath } from '../../../src/kernel/presence.ts'

/** 造一份在场采样：idleMs 之后判「人在不在电脑前」。 */
function sample(idleMs: number, opts: { locked?: boolean; at?: number } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-presence-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(
    presencePath(root),
    JSON.stringify({
      idleMs,
      locked: opts.locked ?? false,
      at: new Date(opts.at ?? Date.now()).toISOString(),
    }),
  )
  return root
}

test('在场：3 分钟内算在，超过算走（阈值对齐参考项目 awayIdleSeconds=180）', () => {
  assert.equal(isPresent(sample(10_000)), true, '刚动过鼠标')
  assert.equal(isPresent(sample(179_000)), true, '2 分 59 秒还在（旧阈值 120 秒会误判成离开）')
  assert.equal(isPresent(sample(181_000)), false, '3 分 1 秒算离开')
})

test('在场：锁屏一律算离开，采样过期算不知道（当离开）', () => {
  assert.equal(isPresent(sample(1_000, { locked: true })), false, '锁屏前刚动过鼠标也不算在')
  assert.equal(isPresent(sample(1_000, { at: Date.now() - 60_000 })), false, '15 秒前的采样不能当现状')
})
