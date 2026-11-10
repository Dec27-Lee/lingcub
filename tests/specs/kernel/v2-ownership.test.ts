import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterByOwnership, ownershipProblem } from '../../../src/kernel/plugin-v2/ownership.ts'

const manifest = (id: string, owns: readonly ('status' | 'stop' | 'new' | 'messages')[]) =>
  ({ manifest: { v: 2 as const, id, roles: ['scenario' as const], owns, config: {} as never } })

test('控制权：开关没切到场景档就不装配，避免与旧 Pipeline 双回', () => {
  assert.equal(ownershipProblem(['status', 'stop', 'new'], { status: 'scenario', stop: 'scenario', new: 'scenario' }), null)
  assert.match(
    String(ownershipProblem(['status'], { status: 'pipeline' })),
    /status=pipeline/,
  )
  assert.equal(ownershipProblem(['messages'], { messages: 'bus' }), null)
  assert.match(String(ownershipProblem(['messages'], { messages: 'pipeline' })), /messages=pipeline/)

  const { kept, skipped } = filterByOwnership(
    [
      manifest('scenario-console', ['status', 'stop', 'new']),
      manifest('scenario-dev-dispatch', ['messages']),
      manifest('capability-x', undefined),
    ],
    { status: 'scenario', stop: 'pipeline', new: 'scenario', messages: 'bus' },
  )
  assert.deepEqual(kept.map((p) => p.manifest.id), ['scenario-dev-dispatch', 'capability-x'])
  assert.deepEqual(skipped.map((s) => s.id), ['scenario-console'])
})

test('控制权：未启用的插件不装配也不告警', () => {
  const r = filterByOwnership([manifest('scenario-doc-todos', ['messages'])], { messages: 'pipeline' }, {
    'scenario-doc-todos': false,
  })
  assert.deepEqual(r.kept, [])
  assert.deepEqual(r.skipped, [])
  const on = filterByOwnership([manifest('scenario-doc-todos', ['messages'])], { messages: 'pipeline' }, {
    'scenario-doc-todos': true,
  })
  assert.deepEqual(on.skipped.map((s) => s.id), ['scenario-doc-todos'])
})
