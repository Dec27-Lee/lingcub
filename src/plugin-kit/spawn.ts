/** 子进程：长连接按行读（事件流），一次性调用取完整输出（分类、发消息）。 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Log } from '../domain/ports.ts'

/**
 * Windows 上 npm 全局装的是 `xxx.cmd` 壳，不是可执行文件：直接 spawn('claude') 会 ENOENT
 * （Node 20+ 也不允许无 shell 直接跑 .cmd）。所以先把壳解析成真正的目标：
 *   - 壳里指向 `.exe` → 直接用那个 exe
 *   - 壳里指向 `node <script.js>` → 用当前 node 跑那个脚本
 * 解析不到就原样返回，让上层看到真实的启动错误，而不是被我们悄悄换掉。
 */
const resolved = new Map<string, { binary: string; prefixArgs: string[] }>()

export function resolveCommand(binary: string): { binary: string; prefixArgs: string[] } {
  const hit = resolved.get(binary)
  if (hit) return hit
  const fallback = { binary, prefixArgs: [] as string[] }
  if (process.platform !== 'win32' || isAbsolute(binary) || /\.(exe|js|mjs)$/i.test(binary)) {
    resolved.set(binary, fallback)
    return fallback
  }
  // `where claude` 会先命中 npm 的 sh 壳（无扩展名），那个在 Windows 上跑不了；
  // 所以显式按 .cmd / .exe 找
  const candidates: string[] = []
  for (const suffix of ['.exe', '.cmd']) {
    const r = spawnSync('where.exe', [`${binary}${suffix}`], { encoding: 'utf8', windowsHide: true })
    for (const line of (r.stdout ?? '').split(/\r?\n/)) {
      const t = line.trim()
      if (t) candidates.push(t)
    }
  }
  const first = candidates[0]
  if (!first) {
    resolved.set(binary, fallback)
    return fallback
  }
  if (/\.exe$/i.test(first)) {
    const out = { binary: first, prefixArgs: [] as string[] }
    resolved.set(binary, out)
    return out
  }
  // xxx.cmd：从壳里抠出真实目标。npm 的壳里既有 `node.exe` 又有目标脚本，
  // 所以先认 js（那是 npm 的通用形状），再认非 node.exe 的 exe（claude 就是自己的 exe）。
  if (/\.cmd$/i.test(first) && existsSync(first)) {
    const text = readFileSync(first, 'utf8')
    const js = /%dp0%\\?([^"%]+\.(?:js|mjs|cjs))/i.exec(text)?.[1]
    if (js) {
      const out = { binary: process.execPath, prefixArgs: [resolve(dirname(first), js)] }
      resolved.set(binary, out)
      return out
    }
    const exe = /%dp0%\\?([^"%]+\.exe)/i.exec(text)?.[1]
    if (exe && !/^node\.exe$/i.test(exe)) {
      const out = { binary: resolve(dirname(first), exe), prefixArgs: [] as string[] }
      resolved.set(binary, out)
      return out
    }
  }
  resolved.set(binary, fallback)
  return fallback
}

export interface LineProcess {
  stop(): Promise<void>
}

export interface SpawnLinesOptions {
  binary: string
  args: readonly string[]
  cwd?: string
  onLine: (line: string) => void
  onStderr?: (line: string) => void
  onExit?: (code: number | null) => void
  log: Log
  /** 一次性输入：写入后关闭 stdin；长驻来源不传，保持打开（lark-cli 把 EOF 当退出信号）。 */
  input?: string
  /** stop() 等待进程退出的上限，超时后强杀 */
  stopTimeoutMs?: number
}

/** 拉起一个长驻进程，逐行喂给 onLine；stop() 幂等。 */
export function spawnLines(opts: SpawnLinesOptions): LineProcess {
  const cmd = resolveCommand(opts.binary)
  const child: ChildProcessWithoutNullStreams = spawn(cmd.binary, [...cmd.prefixArgs, ...opts.args], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // 长驻进程必须保留 stdin：lark-cli 把 stdin EOF 当退出信号。
  // 只有显式传 input 的一次性输入才关闭，避免 `-` 读 stdin 的命令一直等。
  if (opts.input !== undefined) child.stdin.end(opts.input)
  else child.stdin.on('error', () => {})

  let exited = false
  child.on('error', (e) => {
    opts.log('error', `进程启动失败：${opts.binary} — ${e.message}`)
    exited = true
    opts.onExit?.(-1)
  })
  child.on('exit', (code) => {
    exited = true
    opts.onExit?.(code)
  })

  const out = createInterface({ input: child.stdout })
  out.on('line', (line) => {
    if (line.trim()) opts.onLine(line)
  })
  if (opts.onStderr) {
    const err = createInterface({ input: child.stderr })
    err.on('line', (line) => {
      if (line.trim()) opts.onStderr?.(line)
    })
  }

  let stopping: Promise<void> | null = null
  return {
    stop() {
      stopping ??= new Promise<void>((resolve) => {
        if (exited) return resolve()
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, opts.stopTimeoutMs ?? 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.kill('SIGTERM')
      })
      return stopping
    },
  }
}

export interface RunOnceOptions {
  binary: string
  args: readonly string[]
  cwd?: string
  input?: string
  timeoutMs?: number
}

export interface RunOnceResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 跑一个短命命令并拿到完整输出；超时即杀并按失败返回。 */
export function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  return new Promise((resolvePromise, reject) => {
    const cmd = resolveCommand(opts.binary)
    const child: ChildProcessWithoutNullStreams = spawn(cmd.binary, [...cmd.prefixArgs, ...opts.args], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`命令超时（${opts.timeoutMs ?? 0}ms）：${opts.binary}`))
    }, opts.timeoutMs ?? 120000)

    function finish(err?: Error, code: number | null = null): void {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolvePromise({ code, stdout, stderr })
    }

    child.on('error', (e) => finish(new Error(`进程启动失败：${opts.binary} — ${e.message}`)))
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    child.on('exit', (code) => finish(undefined, code))
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}
