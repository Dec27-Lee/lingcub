import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liveFromAgents, parseAgentsJson } from '../src/plugin-kit/claude-discover.ts'

// 实测样本（2026-11-06 本机 `claude agents --json` 的真实字段）
const SAMPLE = JSON.stringify([
  {
    pid: 33540,
    sessionId: 'c510e321-4f0a-402a-a796-402bd5e25264',
    cwd: 'E:\\Develop_E\\tt\\tt-design-space-ai',
    kind: 'interactive',
    startedAt: 1793838239273,
    name: 'tt-design-space-ai-69',
    status: 'idle',
  },
  {
    pid: 52292,
    sessionId: '5819be82-bda8-4c99-b764-60bb17a142f1',
    cwd: 'E:\\Develop_E\\lingcub',
    kind: 'interactive',
    startedAt: 1793839000000,
    name: 'lingcub-af',
    status: 'busy',
  },
])

test('agents --json：解析出全 uuid / cwd / busy-idle', () => {
  const agents = parseAgentsJson(SAMPLE)
  assert.equal(agents.length, 2)
  assert.equal(agents[0]?.sessionId, 'c510e321-4f0a-402a-a796-402bd5e25264', '必须是全 uuid，不能是 8 位短 id')
  assert.equal(agents[0]?.status, 'idle')
  assert.equal(agents[1]?.status, 'busy')
})

test('agents --json：坏输入（非 JSON / 非数组 / 缺字段）一律跳过，不抛', () => {
  assert.deepEqual(parseAgentsJson('not json'), [])
  assert.deepEqual(parseAgentsJson('{"a":1}'), [])
  assert.deepEqual(parseAgentsJson('[{"pid":1},{"sessionId":"x"}]'), [], '缺 sessionId 或 cwd 都不收')
})

test('agents --json：只列 allowRoots 内、且没过期的会话', () => {
  const now = 1793839100000
  const agents = parseAgentsJson(SAMPLE)
  const inside = liveFromAgents(agents, { roots: ['E:\\Develop_E\\lingcub'], maxAgeDays: 5, nowMs: now })
  assert.deepEqual(
    inside.map((s) => s.cwd),
    ['E:\\Develop_E\\lingcub'],
  )
  assert.equal(inside[0]?.running, true)
  assert.equal(inside[0]?.status, 'busy')

  const stale = liveFromAgents(agents, { roots: ['E:\\Develop_E'], maxAgeDays: 5, nowMs: now + 10 * 24 * 3600_000 })
  assert.deepEqual(stale, [], 'startedAt 超过 resumeDays 的不算')
})

test('agents --json：空数组（一个窗口都没开）退回兜底而不是报错', () => {
  assert.deepEqual(parseAgentsJson('[]'), [])
})
