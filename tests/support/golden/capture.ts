/** 用当前（旧）实现生成金标基线：node --experimental-strip-types tests/support/golden/capture.ts */

import { writeFileSync } from 'node:fs'
import { CASES } from './cases.ts'
import { runCase } from './harness.ts'

const out: { name: string; result: unknown }[] = []
for (const c of CASES) out.push({ name: c.name, result: await runCase(c) })
writeFileSync(new URL('./baseline.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(`wrote ${out.length} cases`)
