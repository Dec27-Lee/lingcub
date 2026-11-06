import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CASES } from './golden/cases.ts'
import { runCase } from './golden/harness.ts'

interface BaselineRow {
  name: string
  result: unknown
}

const baseline = JSON.parse(
  readFileSync(new URL('./golden/baseline.json', import.meta.url), 'utf8'),
) as BaselineRow[]

test('控制台金标：固定输入与基线逐字一致', async () => {
  assert.equal(CASES.length, 44)
  assert.equal(baseline.length, 44)
  for (const [i, c] of CASES.entries()) {
    const row = baseline[i]
    assert.equal(row?.name, c.name, `第 ${i + 1} 条用例名不一致`)
    assert.deepEqual(await runCase(c), row.result, c.name)
  }
})
