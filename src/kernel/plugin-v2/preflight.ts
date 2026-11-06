/** 切换前静态检查：控制开关与 v2 场景/来源是否配套，避免双回或空转。 */

import type { Config } from '../config.ts'

export function switchProblems(config: Config, enabled: Record<string, boolean>): string[] {
  const problems: string[] = []
  const control = config.control
  if (!control) return problems

  const scenes = ['status', 'stop', 'new'] as const
  if (scenes.some((k) => control[k] === 'scenario') && enabled['scenario-console'] !== true) {
    problems.push('control.status/stop/new 已切 scenario，但 scenario-console 未启用')
  }
  if (scenes.every((k) => control[k] !== 'scenario') && enabled['scenario-console'] === true) {
    problems.push('scenario-console 已启用，但 control.status/stop/new 仍是 pipeline（会双回）')
  }

  const dispatch = enabled['scenario-dev-dispatch'] === true
  const post = enabled['scenario-session-post'] === true
  if (control.messages === 'bus') {
    if (!dispatch && !post) problems.push('control.messages=bus，但没有启用任何消息场景（消息只会落库）')
    if (enabled['source-feishu-card-v2'] !== true) problems.push('messages=bus，但 source-feishu-card-v2 未启用（卡片回调进不来）')
  } else if (dispatch || post) {
    problems.push('消息场景已启用，但 control.messages 仍是 pipeline（会双派工）')
  }

  if (control.messages === 'bus' && config.sessions?.newTopicPolicy === 'open') {
    problems.push('messages=bus 时不支持 newTopicPolicy=open（新话题开窗还在旧 Pipeline）')
  }

  if (config.sources['feishu-card']?.enabled && enabled['source-feishu-card-v2'] === true) {
    problems.push('v1 feishu-card 与 v2 source-feishu-card-v2 同时启用（同源双消费者）')
  }
  return problems
}


