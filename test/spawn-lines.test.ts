import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnLines } from '../src/plugin-kit/spawn.ts'

const silent = (): void => {}

const script = [
  "process.stdin.resume();",
  "process.stdin.on('end',()=>process.exit(7));",
  "setInterval(()=>{},1000);",
].join('')

test('spawnLines：不传 input 时 stdin 保持打开，lark-cli 不会因 EOF 退出', async () => {
  let exited: number | null | undefined
  const p = spawnLines({
    binary: process.execPath,
    args: ['-e', script],
    log: silent,
    onLine: () => {},
    onExit: (code) => {
      exited = code
    },
  })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(exited, undefined, 'stdin 被关闭时子进程会 exit 7')
  await p.stop()
})

test('spawnLines：传 input 时写完即关闭 stdin', async () => {
  const code = await new Promise<number | null>((resolve) => {
    spawnLines({
      binary: process.execPath,
      args: ['-e', script],
      input: 'hello',
      log: silent,
      onLine: () => {},
      onExit: resolve,
    })
  })
  assert.equal(code, 7)
})
