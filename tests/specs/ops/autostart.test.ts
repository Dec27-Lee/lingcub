import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { findRoot, linuxTarget, macTarget, winTarget } from '../../../scripts/install-autostart.mjs'

test('Windows 自启：装 .vbs、窗口样式 0，且能清掉旧的 .cmd', () => {
  const t = winTarget('E:\\repo', 'C:\\Users\\x\\AppData\\Roaming')
  assert.ok(t.file.endsWith('lingcub.vbs'), `应装 .vbs，实际 ${t.file}`)
  assert.ok(t.content.includes('start-hidden.vbs'), '要转调隐藏启动脚本')
  assert.ok(t.content.includes(', 0, False'), '窗口样式必须 0（隐藏）且不阻塞')
  assert.ok(
    t.legacy.some((f) => f.endsWith('lingcub.cmd')),
    '卸载要一并清掉旧 .cmd，否则两份自启抢着起',
  )
})

test('mac / linux 自启：都指向 run-lingcub.sh，子命令由看门狗兜底', () => {
  const mac = macTarget('/repo', '/Users/x')
  assert.ok(mac.file.endsWith('com.yue.lingcub.plist'))
  assert.ok(mac.content.includes('/repo/scripts/run-lingcub.sh'))
  assert.ok(mac.content.includes('<key>RunAtLoad</key><true/>'))

  const linux = linuxTarget('/repo', '/home/x')
  assert.ok(linux.file.endsWith('lingcub.service'))
  assert.ok(linux.content.includes('ExecStart=/bin/sh /repo/scripts/run-lingcub.sh'))
  assert.ok(linux.content.includes('Restart=on-failure'))
})

test('findRoot：从当前目录向上找到带包标记的项目根', () => {
  const root = findRoot(process.cwd())
  assert.equal(root, process.cwd())
  assert.ok(existsSync(join(root, 'package.json')))
})
