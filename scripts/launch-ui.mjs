#!/usr/bin/env node
/**
 * 三端入口：双击/运行这个脚本 → 复用已跑的面板，没有就起一个，再打开独立窗口。
 *
 * 它靠自己向上找 package.json 定位项目根，所以整个目录挪位置、或者把入口拖到别处都不会断
 * （快捷方式记的是绝对路径，一挪就废，所以入口直接放脚本而不是快捷方式）。
 *
 * 注意：这是 .mjs，不做类型擦除，所以本文件里不能写 TS 注解。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { findRunningUi, readUiInfo } from '../src/desktop/registry.ts'

const MARK = '"@yue/lingcub"'

function findRoot(start) {
  let dir = start
  for (;;) {
    const pkg = resolve(dir, 'package.json')
    if (existsSync(pkg) && readFileSync(pkg, 'utf8').includes(MARK)) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error(`向上找不到项目根（从 ${start} 起）`)
    dir = up
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const root = findRoot(dirname(resolve(process.argv[1] ?? '.')))
  const running = findRunningUi(root)
  if (running) {
    process.stderr.write(`面板已在运行：${running.url}\n`)
    console.log(running.url)
    return
  }

  const entry = existsSync(resolve(root, 'dist/main.js'))
    ? resolve(root, 'dist/main.js')
    : resolve(root, 'src/main.ts')
  const child = spawn(process.execPath, [entry, 'ui', '--no-open'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  // 等它把登记文件写出来并探活（最多 15 秒）
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    const info = readUiInfo(root)
    if (!info) continue
    const ok = await fetch(`http://127.0.0.1:${info.port}/healthz`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) {
      process.stderr.write(`面板已启动：${info.url}\n`)
      console.log(info.url)
      return
    }
  }
  throw new Error('面板启动超时：15 秒内没拿到 /healthz')
}

await main().catch((e) => {
  process.stderr.write(`启动面板失败：${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
})
