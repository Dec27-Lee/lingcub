/**
 * 在场采样：回答「人现在是否在电脑前」。
 *
 * 为什么要它：代答类钩子一旦拦下来，终端里的弹窗就不会渲染，整轮阻塞等人从手机答。
 * 人明明坐在电脑前却被拦去飞书，是最难受的体验——所以必须知道人在不在。
 *
 * Node 读不到 Windows 的「最后输入时间」，只能问系统：起一个常驻 PowerShell，
 * 每 `intervalMs` 打一行 GetLastInputInfo 折算的空闲毫秒，我们转成 `data/presence.json`。
 * 采样失败就**不写文件**——内核读不到文件按「不在」处理，照常推卡，绝不让人干等。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import type { Log } from '../domain/ports.ts'

/**
 * GetLastInputInfo 折算空闲毫秒；顺序输出，供 Node 逐行消费。
 *
 * 注意 PowerShell 的 here-string：开头的 `@'` 后面必须立刻换行、结尾的 `'@` 必须顶格，
 * 多一个空格就整段解析失败（采样器会静默退化，人明明在电脑前却被拦到手机上答）。
 */
export function idleScript(intervalMs: number): string {
  return `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LingcubIdle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  public static uint IdleMs() {
    LASTINPUTINFO i = new LASTINPUTINFO();
    i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return 0;
    return (uint)Environment.TickCount - i.dwTime;
  }
}
'@
while ($true) { [Console]::Out.WriteLine([LingcubIdle]::IdleMs()); Start-Sleep -Milliseconds ${intervalMs} }`
}

export interface PresenceSampler {
  stop: () => Promise<void>
}

export function startPresenceSampler(opts: {
  /** 写到哪个文件；内核按这个路径读（`data/presence.json`） */
  file: string
  intervalMs?: number
  log: Log
}): PresenceSampler {
  const interval = Math.max(500, opts.intervalMs ?? 2000)
  const script = idleScript(interval)
  let child: ChildProcess | null = null
  let stopped = false
  let buffer = ''
  let failed = false

  try {
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch (e) {
    opts.log('warn', `在场采样没起来（一律按「不在电脑前」处理）：${e instanceof Error ? e.message : String(e)}`)
    return { stop: async () => {} }
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const idle = Number(line.trim())
      if (!Number.isFinite(idle)) continue
      try {
        writeFileSync(
          opts.file,
          JSON.stringify({ idleMs: idle, locked: false, at: new Date().toISOString() }),
          'utf8',
        )
      } catch {
        /* 写不了就不写：内核读不到会按「不在」处理 */
      }
    }
  })
  child.on('error', (e) => {
    if (failed || stopped) return
    failed = true
    opts.log('warn', `在场采样异常（一律按「不在电脑前」处理）：${e.message}`)
  })
  child.on('exit', (code) => {
    if (stopped || failed) return
    failed = true
    opts.log('warn', `在场采样退出（code=${code}），之后一律按「不在电脑前」处理`)
  })

  return {
    stop: async () => {
      stopped = true
      if (!child || child.killed) return
      child.kill()
      child = null
    },
  }
}
