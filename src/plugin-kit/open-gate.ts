/**
 * 开窗闸门：同一个「模式 + 工作区」在窗口期内只允许开一次。
 *
 * 为什么需要：飞书卡片按钮没有服务端幂等，用户点两下、或事件被重投，
 * 就会真的再拉起一个终端窗口。窗口关了不会自动收拾，所以闸门放在执行器一侧。
 * 纯函数，时间由调用方传进来，方便钉死。
 */

export function openGate(
  recent: Map<string, number>,
  key: string,
  now: number,
  windowMs = 60_000,
): boolean {
  const last = recent.get(key)
  if (last !== undefined && now - last < windowMs) return false
  recent.set(key, now)
  return true
}
