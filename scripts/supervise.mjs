/**
 * 看门狗：把 `lingcub run` 拉起来并在崩了之后按退避重试。
 *
 * 退出码语义（与 scripts/run-lingcub.sh 一致）：
 *   75  = 「保存并重启」请求 → 立刻拉起新进程，不计失败
 *   0   = 正常结束 → 不重启
 *   其它 = 崩溃 → 退避后重试
 *
 * 退避分级（参考项目 watch-bridge.vbs 的做法）：
 *   连续失败 1-4 次 5 秒；5-19 次 30 秒；20 次以上 300 秒。
 *   跑满 60 秒算「活过一阵」，失败计数清零——偶尔重启一次不该越拖越久。
 *
 * 用法：node scripts/supervise.mjs [--dry-run] [--] [lingcub run 的参数…]
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RESTART_EXIT_CODE = 75
const STABLE_MS = 60_000

/**
 * 传给子进程的参数：没给子命令时默认 `run`。
 *
 * 不带子命令的 `dist/main.js` 跑的是 `doctor`，跑完 exit 0，看门狗按「正常结束」直接退出——
 * 于是任何漏传 `run` 的启动器（隐藏启动脚本、开机自启、mac/linux 服务）都表现为
 * 「装了但常驻没起来」，且悄无声息。兜在这里，新增启动路径也不会再漏。
 */
export function resolveArgs(argv) {
  const rest = argv.filter((a) => a !== '--dry-run')
  return rest.length ? rest : ['run']
}

/** 连续失败 n 次后，等多久再拉（毫秒）。纯函数，方便测。 */
export function backoffMs(consecutiveFailures) {
  if (consecutiveFailures <= 0) return 0
  if (consecutiveFailures >= 20) return 300_000
  if (consecutiveFailures >= 5) return 30_000
  return 5_000
}

/** 跑一轮之后，下一轮的失败计数怎么变。纯函数。 */
export function nextFailures({ code, ranMs, failures }) {
  if (code === RESTART_EXIT_CODE) return 0 // 主动重启：不算失败
  if (code === 0) return 0
  if (ranMs >= STABLE_MS) return 0 // 活过一阵才崩：从头计
  return failures + 1
}

function sleep(ms, signal) {
  return new Promise((p) => {
    const t = setTimeout(p, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      p()
    }, { once: true })
  })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const args = resolveArgs(argv)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  if (dryRun) {
    console.log('看门狗预演（不真的起进程）：')
    for (const n of [0, 1, 5, 19, 20]) {
      console.log(`  连续失败 ${n} 次 → 下次等 ${backoffMs(n) / 1000} 秒`)
    }
    console.log(`  退出码 ${RESTART_EXIT_CODE} = 立刻重启；0 = 不重启；跑满 ${STABLE_MS / 1000} 秒清零`)
    process.exit(0)
  }

  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())

  let failures = 0
  for (;;) {
    const startedAt = Date.now()
    const code = await new Promise((resolveCode) => {
      // windowsHide：node.exe 是控制台程序，不隐藏的话每次重启都会弹出一个黑窗口；
      // 用户关掉它 = 杀掉子进程 = 看门狗再拉一次，表现就是「窗口关不掉」。
      const child = spawn(process.execPath, ['dist/main.js', ...args], {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
      })
      child.on('exit', (c, signal) => resolveCode(signal ? 1 : (c ?? 1)))
      controller.signal.addEventListener('abort', () => child.kill(), { once: true })
    })
    if (controller.signal.aborted) break
    if (code === 0) break

    const ranMs = Date.now() - startedAt
    failures = nextFailures({ code, ranMs, failures })
    if (code === RESTART_EXIT_CODE) {
      console.error('[lingcub] 收到重启请求，正在拉起新进程…')
      continue
    }
    const wait = backoffMs(failures)
    console.error(`[lingcub] 进程退出（code=${code}，跑了 ${Math.round(ranMs / 1000)} 秒），${wait / 1000} 秒后重试（连续第 ${failures} 次）`)
    await sleep(wait, controller.signal)
    if (controller.signal.aborted) break
  }
}
