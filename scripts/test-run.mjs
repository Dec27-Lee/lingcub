/**
 * 跑全量测试，并把测试自己的临时目录收进一个可回收的根。
 *
 * 为什么要有这层：用例里到处是 `mkdtempSync(join(tmpdir(), 'lingcub-xxx-'))`，
 * 而 `%TEMP%` 没人收——2026-11-10 实测堆了 **3.7 万个** `lingcub-*` 目录、212 个
 * `lc-dingtalk-sent-*`。测试基础设施的垃圾不该由用户定期手动清。
 *
 * 做法：子进程的 TEMP/TMP/TMPDIR 指向 `<tmpdir>/lingcub-test/<时间戳>`，
 * 跑完（含异常与 Ctrl-C）整棵删掉。用例代码一行都不用改。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const base = join(tmpdir(), 'lingcub-test')
const sandbox = join(base, `run-${process.pid}-${Date.now()}`)

mkdirSync(sandbox, { recursive: true })

const cleanup = () => {
  rmSync(sandbox, { recursive: true, force: true })
  // 父目录空了就一起收掉；还有别的一起在跑的进程时不强删
  try {
    rmdirSync(base)
  } catch {
    /* 目录非空 = 还有别的测试在跑，留着 */
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

const args = process.argv.slice(2)
const r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...(args.length ? args : ['tests/specs/**/*.test.ts'])], {
  cwd: root,
  env: { ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox },
  stdio: 'inherit',
})

cleanup()
process.exit(r.status ?? 1)
