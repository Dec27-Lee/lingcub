/**
 * 能力路径的会话启动：起执行器 → 会话行 → 工作项 running。
 * 与 `dispatch_session` 的区别：不建飞书窗口、不发锚消息/卡片，来源会话已由渠道插件确定。
 */

import type { Action } from '../domain/types.ts'
import type { Log } from '../domain/ports.ts'
import { assertAllowedRoot, type Config } from './config.ts'
import type { Store } from './store.ts'
import type { Ports } from './wiring.ts'

export async function startSession(
  action: Extract<Action, { kind: 'start_session' }>,
  deps: { config: Config; ports: Ports; store: Store; log: Log },
): Promise<{ externalId?: string }> {
  const work = action.work
  const policy = deps.config.executor_policies[work.executor]
  if (!policy) throw new Error(`执行器 ${work.executor} 在 executor_policies 里没有策略`)
  assertAllowedRoot(work.workspace, policy.allowRoots)
  const exec = deps.ports.executors.get(policy.plugin)
  if (!exec) throw new Error(`执行器插件未就绪：${policy.plugin}`)

  const handle = await exec.start(work)
  deps.store.setWorkStatus(work.id, 'running', handle.sessionId)

  const sessionId = `sess-${work.id}`
  if (work.origin?.rebindSessionId) {
    // #resume：沿用原会话行，把执行器 id/工作区换掉，不新增会话
    deps.store.rebindSession(work.origin.rebindSessionId, handle.sessionId, work.project)
  } else if (!deps.store.getSession(sessionId)) {
    const now = new Date().toISOString()
    deps.store.insertSession({
      id: sessionId,
      chatId: work.origin?.chatId ?? '',
      source: work.origin?.source,
      threadId: work.origin?.threadId ?? work.origin?.rootMessageId,
      rootMessageId: work.origin?.rootMessageId,
      ownerId: work.ownerId,
      title: work.origin?.title ?? work.prompt.slice(0, 40),
      executor: work.executor,
      workspace: work.project,
      sessionId: handle.sessionId,
      status: 'active',
      createdAt: now,
      lastActiveAt: now,
    })
  }
  deps.log('info', `能力起会话：${work.executor}/${handle.sessionId} @ ${work.workspace} → ${work.origin?.rebindSessionId ?? sessionId}`)
  return { externalId: handle.sessionId }
}
