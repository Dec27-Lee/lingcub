#!/usr/bin/env node
/**
 * 开机自启安装器（默认只预演，加 --apply 才写盘；--uninstall 卸载）。
 *
 * 三端都用「用户级、无需管理员」的办法：
 *   win32  → 启动文件夹里放一个 .vbs（登录即跑，且完全不弹窗口）
 *   darwin → ~/Library/LaunchAgents 的 plist（RunAtLoad）
 *   linux  → ~/.config/systemd/user 的 unit（用 systemctl --user 启用）
 *
 * 它不启动任何东西：装完由系统在下次登录时拉起，避免安装即起两份。
 *
 * Windows 用 .vbs 而不是 .cmd：.cmd 会在任务栏留一个最小化的黑窗口，
 * 与「常驻无窗口」的验收冲突；.vbs 由 wscript 承载，窗口数为零。
 * 子命令（run）由 scripts/supervise.mjs 兜底默认，启动器不必重复传。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARK = '"@yue/lingcub"'

export function findRoot(start) {
  let dir = start
  for (;;) {
    const pkg = resolve(dir, 'package.json')
    if (existsSync(pkg) && readFileSync(pkg, 'utf8').includes(MARK)) return dir
    const up = resolve(dir, '..')
    if (up === dir) throw new Error('找不到项目根')
    dir = up
  }
}

/** Windows：启动文件夹放 .vbs，转调 start-hidden.vbs（窗口样式 0 = 隐藏，False = 不等它）。 */
export function winTarget(root, appData = process.env.APPDATA ?? join(homedir(), 'AppData/Roaming')) {
  const startup = join(appData, 'Microsoft/Windows/Start Menu/Programs/Startup')
  const launcher = join(root, 'scripts', 'start-hidden.vbs')
  return {
    file: join(startup, 'lingcub.vbs'),
    content: `' 登录时静默拉起 lingcub 常驻。卸载：删掉本文件。\r\nCreateObject("WScript.Shell").Run """${launcher}""", 0, False\r\n`,
    /** 更早的版本写过 .cmd，卸载时一并清掉，免得两份自启抢着起 */
    legacy: [join(startup, 'lingcub.cmd')],
  }
}

export function macTarget(root, home = homedir()) {
  const file = join(home, 'Library/LaunchAgents/com.yue.lingcub.plist')
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.yue.lingcub</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${root}/scripts/run-lingcub.sh</string></array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${root}/data/autostart.out.log</string>
  <key>StandardErrorPath</key><string>${root}/data/autostart.err.log</string>
</dict></plist>
`
  return { file, content, legacy: [] }
}

export function linuxTarget(root, home = homedir()) {
  const file = join(home, '.config/systemd/user/lingcub.service')
  const content = `[Unit]
Description=幺幺零 · Lingcub 常驻
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=/bin/sh ${root}/scripts/run-lingcub.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
  return { file, content, legacy: [] }
}

export function target(root, platform = process.platform) {
  if (platform === 'win32') return winTarget(root)
  if (platform === 'darwin') return macTarget(root)
  return linuxTarget(root)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const apply = process.argv.includes('--apply')
  const uninstall = process.argv.includes('--uninstall')
  const out = (s) => process.stdout.write(s + '\n')
  const root = findRoot(process.cwd())
  const { file, content, legacy = [] } = target(root)

  if (uninstall) {
    let removed = 0
    for (const f of [file, ...legacy]) {
      if (!existsSync(f)) continue
      if (apply) rmSync(f)
      out(`已删除：${f}`)
      removed++
    }
    if (removed === 0) out(`没有安装过：${file}`)
  } else {
    out(`目标文件：${file}`)
    out(apply ? '写入中…' : '预演（没写盘）。确认后加 --apply')
    if (apply) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
      out('已写入。下次登录会自动拉起 lingcub run。')
      if (process.platform === 'linux') out('提示：还要执行 systemctl --user enable --now lingcub.service')
      if (process.platform === 'darwin') out('提示：还要执行 launchctl load ~/Library/LaunchAgents/com.yue.lingcub.plist')
    }
  }
}
