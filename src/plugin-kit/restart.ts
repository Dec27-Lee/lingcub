/**
 * 消费进程退出后的重试节奏（纯函数，方便钉死）。
 *
 * 两种情况完全不一样：
 *   · 订阅没配（lark-cli 以 code=2 反复退出）——修不了，只能慢慢试，别刷屏；
 *     我们按 60 秒一次，并在日志里明说到底缺什么。
 *   · 其它异常退出——5 秒起重试，每次翻倍，最多 60 秒。
 */

export interface RestartPolicy {
  /** 订阅没配时的固定间隔（参考项目 60 秒） */
  missingSubDelayMs?: number
  /** 普通异常的起始间隔 */
  baseDelayMs?: number
  /** 普通异常的上限 */
  maxDelayMs?: number
}

/** code=2 在飞书 CLI 里就是「订阅没配」。 */
export const MISSING_SUBSCRIPTION_CODE = 2

export function restartDelay(code: number, attempt: number, policy: RestartPolicy = {}): number {
  const missing = policy.missingSubDelayMs ?? 60_000
  if (code === MISSING_SUBSCRIPTION_CODE) return missing
  const base = policy.baseDelayMs ?? 5_000
  const max = policy.maxDelayMs ?? 60_000
  const n = Math.max(1, attempt)
  return Math.min(max, base * 2 ** (n - 1))
}

/** 退出原因的一句话说明：给日志和用户看。 */
export function explainExit(code: number, what = '消费进程'): string {
  if (code === MISSING_SUBSCRIPTION_CODE) {
    return `${what}以 code=2 退出：开发者后台没订阅这个事件，按钮/消息不会进来（已按 60 秒重试）`
  }
  if (code === 0) return `${what}正常结束`
  return `${what}异常退出（code=${code}）`
}
