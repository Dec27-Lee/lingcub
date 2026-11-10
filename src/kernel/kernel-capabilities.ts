/** 内核能力：出口能力（notify.*）+ 判断/工作区查询。副作用能力的实现不在同步路径里被调用。 */

import { z } from 'zod'
import { resolve } from 'node:path'
import type { Capabilities } from './capabilities.ts'
import type { Config, Projects } from './config.ts'
import type { Ports } from './wiring.ts'
import type { Store } from './store.ts'
import type { Classifier, Log } from '../domain/ports.ts'
import type { Event, Intent } from '../domain/types.ts'
import type { Ruleset } from '../routing/rules.ts'
import { evaluate } from '../routing/rules.ts'
import { summarizeWorkstation } from '../domain/workstation.ts'
import { routeToSession } from '../routing/session-route.ts'

const EventInput = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  externalId: z.string(),
  receivedAt: z.string(),
  occurredAt: z.string(),
  actor: z.object({ id: z.string(), name: z.string().optional() }),
  channel: z.object({
    kind: z.enum(['dm', 'group', 'doc', 'task']),
    id: z.string(),
    name: z.string().optional(),
  }),
  text: z.string(),
  raw: z.unknown(),
  threadId: z.string().optional(),
  rootId: z.string().optional(),
  replyTo: z.string().optional(),
  atMe: z.boolean().optional(),
  imageKey: z.string().optional(),
  imageKeys: z.array(z.string()).optional(),
})

const IntentOut = z
  .object({
    eventId: z.string(),
    kind: z.enum(['dev-request', 'bug', 'question', 'chatter', 'doc-update', 'todo']),
    topic: z.string(),
    project: z.string().optional(),
    suggestedAction: z.enum(['dispatch_session', 'reply_only', 'update_doc', 'create_todo']),
    rationale: z.string(),
    confidence: z.number(),
    byRule: z.string().optional(),
  })
  .nullable()

const Target = z.object({
  channel: z.string().min(1),
  chatId: z.string().min(1),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
})

const IntentInput = z.object({
  eventId: z.string().min(1),
  kind: z.enum(['dev-request', 'bug', 'question', 'chatter', 'doc-update', 'todo']),
  topic: z.string().min(1),
  project: z.string().optional(),
  suggestedAction: z.enum(['dispatch_session', 'reply_only', 'update_doc', 'create_todo']),
  rationale: z.string(),
  confidence: z.number(),
  byRule: z.string().optional(),
})

const WorkInput = z.object({
  id: z.string().min(1),
  intentId: z.string().min(1),
  kind: z.enum(['session', 'reply', 'doc']),
  via: z.enum(['pipeline', 'event']).optional(),
  project: z.string().min(1),
  executor: z.enum(['claude', 'dsh']),
  workspace: z.string().min(1),
  prompt: z.string(),
  resumeSessionId: z.string().optional(),
  budgetUsd: z.number().optional(),
  sessionId: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  origin: z
    .object({
      chatId: z.string(),
      source: z.string().optional(),
      title: z.string().optional(),
      threadId: z.string().optional(),
      rootMessageId: z.string().optional(),
      rebindSessionId: z.string().optional(),
    })
    .optional(),
  ownerId: z.string().optional(),
})

function submitOnly(
  capabilities: Capabilities,
  name: string,
  effect: 'session' | 'message' | 'doc',
  input: z.ZodTypeAny,
): void {
  capabilities.provide(
    { name, effect, input },
    () => {
      throw new Error(`${name} 是提交型能力，不能同步 call`)
    },
    { provider: 'kernel', internal: true },
  )
}

const SessionOut = z
  .object({
    id: z.string(),
    chatId: z.string(),
    threadId: z.string().optional(),
    rootMessageId: z.string().optional(),
    ownerId: z.string().optional(),
    title: z.string().optional(),
    executor: z.enum(['claude', 'dsh']),
    workspace: z.string(),
    sessionId: z.string().optional(),
    status: z.enum(['active', 'idle', 'stopped', 'dead']),
    createdAt: z.string(),
    lastActiveAt: z.string(),
    /** 会话来自哪个来源（场景判断「结果该回哪个渠道」要用；漏了它结果回执永远不发） */
    source: z.string().optional(),
  })
  .nullable()

export interface KernelCapabilityDeps {
  capabilities: Capabilities
  config: Config
  projects: Projects
  rules: Ruleset
  classifier?: { impl: Classifier; minConfidence: number }
  ports: Ports
  store: Store
  log: Log
}

export function registerKernelCapabilities(deps: KernelCapabilityDeps): void {
  const { capabilities, config, projects, rules, classifier, ports, store, log } = deps

  // 出口能力：只经 submit 入发件箱，impl 永远不会被同步调用。
  capabilities.provide(
    {
      name: 'notify.reply',
      effect: 'message',
      input: z.object({ target: Target, text: z.string().min(1) }),
    },
    () => {
      throw new Error('notify.reply 是提交型能力，不能同步 call')
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'task.open',
      effect: 'task',
      input: z.object({
        event: EventInput,
        intent: IntentInput,
        dispatch: z.boolean().default(false),
        /** P2.6：event 时只发 session.open.requested，由执行器插件开窗；默认仍走旧 Pipeline */
        via: z.enum(['pipeline', 'event']).default('pipeline'),
        mode: z.enum(['terminal', 'headless']).default('terminal'),
      }),
    },
    () => {
      throw new Error('task.open 是提交型能力，不能同步 call')
    },
    { provider: 'kernel', internal: true },
  )

  // 只读：场景要拿文档 revision/正文，才能安全地再调 doc.write。
  capabilities.provide(
    {
      name: 'state.doc.snapshot',
      effect: 'none',
      input: z.object({ doc: z.string().min(1), port: z.string().optional() }),
      output: z.object({ revision: z.string(), markdown: z.string() }),
    },
    async (input) => {
      const port = input.port ? ports.docs?.get(input.port) : ports.docs?.values().next().value
      if (!port) throw new Error('没有可用的文档端口（config.docs）')
      return port.read(input.doc)
    },
    { provider: 'kernel', internal: true },
  )

  // 文档写回：经发件箱，执行时再由 DocPort 读快照/比对/写回。
  submitOnly(
    capabilities,
    'doc.write',
    'doc',
    z.object({
      doc: z.string().min(1),
      heading: z.string().min(1),
      body: z.string(),
      revision: z.string(),
      fingerprint: z.string().min(1),
    }),
  )

  // 控制台九分支的能力化入口（P3.1）：只负责校验与入队，执行仍由 createDeliver 适配器完成。
  submitOnly(capabilities, 'session.dispatch', 'session', z.object({ work: WorkInput }))
  submitOnly(capabilities, 'session.start', 'session', z.object({ work: WorkInput }))
  // P2.6：只落请求并发 session.open.requested，真正开窗由执行器插件消费。
  submitOnly(
    capabilities,
    'session.open',
    'session',
    z.object({
      work: WorkInput,
      mode: z.enum(['terminal', 'headless']).default('terminal'),
    }),
  )
  submitOnly(capabilities, 'session.close', 'session', z.object({ sessionId: z.string().min(1) }))
  submitOnly(
    capabilities,
    'session.attach',
    'session',
    z.object({
      chatId: z.string().min(1),
      threadId: z.string().optional(),
      rootMessageId: z.string().optional(),
      executorSessionId: z.string().min(1),
      workspace: z.string().min(1),
      executor: z.enum(['claude', 'dsh']).default('claude'),
    }),
  )
  submitOnly(
    capabilities,
    'session.bind',
    'session',
    z.object({
      sessionId: z.string().min(1),
      executorSessionId: z.string().min(1),
      workspace: z.string().min(1),
    }),
  )
  submitOnly(
    capabilities,
    'session.answer',
    'session',
    z.object({
      sessionId: z.string().min(1),
      questionId: z.string().min(1),
      answers: z.record(z.string()),
    }),
  )
  submitOnly(capabilities, 'session.post', 'session', z.object({ sessionId: z.string().min(1), text: z.string() }))
  submitOnly(capabilities, 'session.stop', 'session', z.object({ sessionId: z.string().min(1) }))
  submitOnly(
    capabilities,
    'notify.card.send',
    'message',
    z.object({
      chatId: z.string().min(1),
      channel: z.string().optional(),
      replyTo: z.string().optional(),
      card: z.unknown(),
      sessionId: z.string().optional(),
    }),
  )
  submitOnly(
    capabilities,
    'notify.card.patch',
    'message',
    z.object({ chatId: z.string().min(1), messageId: z.string().min(1), card: z.unknown() }),
  )
  submitOnly(
    capabilities,
    'notify.dm.send',
    'message',
    z.object({ userId: z.string().min(1), card: z.unknown() }),
  )
  submitOnly(
    capabilities,
    'notify.card.upsert',
    'message',
    z.object({ sessionId: z.string().min(1), card: z.unknown(), signature: z.string().min(1) }),
  )
  submitOnly(
    capabilities,
    'notify.card.pin',
    'message',
    z.object({ sessionId: z.string().min(1), pin: z.boolean() }),
  )

  capabilities.provide(
    {
      name: 'state.session.get',
      effect: 'none',
      input: z.object({ sessionId: z.string().min(1) }),
      output: SessionOut,
    },
    (input) => store.getSession(input.sessionId),
    { provider: 'kernel', internal: true },
  )

  // 只读：持续推进场景要判断任务状态，不能靠内存变量。
  capabilities.provide(
    {
      name: 'state.work.get',
      effect: 'none',
      input: z.object({ workId: z.string().min(1) }),
      output: z
        .object({
          id: z.string(),
          intentId: z.string(),
          kind: z.enum(['session', 'reply', 'doc']),
          project: z.string(),
          executor: z.enum(['claude', 'dsh']),
          workspace: z.string(),
          prompt: z.string(),
          sessionId: z.string().optional(),
          status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
        })
        .nullable(),
    },
    (input) => {
      const w = store.getWork(input.workId)
      if (!w) return null
      return {
        id: w.id,
        intentId: w.intentId,
        kind: w.kind,
        project: w.project,
        executor: w.executor,
        workspace: w.workspace,
        prompt: w.prompt,
        sessionId: w.sessionId,
        status: w.status,
      }
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.session.turns',
      effect: 'none',
      input: z.object({ sessionId: z.string().min(1) }),
      output: z.object({ turns: z.number().int().nonnegative() }),
    },
    (input) => ({ turns: store.getSessionTurns(input.sessionId) }),
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.session.route',
      effect: 'none',
      input: z.object({
        chatId: z.string().min(1),
        threadId: z.string().optional(),
        /** 话题内回复指向的根消息 id（`om_…`）：新话题的第一条消息只有 rootId 有值 */
        rootId: z.string().optional(),
      }),
      output: SessionOut,
    },
    (input) => routeToSession(store, input.chatId, input.threadId) ?? routeToSession(store, input.chatId, input.rootId),
    { provider: 'kernel', internal: true },
  )

  // 只读：给场景列历史会话（#resume）用；不暴露写操作。
  capabilities.provide(
    {
      name: 'state.session.list',
      effect: 'none',
      input: z.object({
        chatId: z.string().optional(),
        threadId: z.string().optional(),
        status: z.enum(['active', 'idle', 'stopped', 'dead']).optional(),
        limit: z.number().int().positive().max(50).default(8),
      }),
      output: z.array(SessionOut.unwrap()),
    },
    (input) =>
      store
        .listSessions(input.status)
        .filter((s) => !input.chatId || s.chatId === input.chatId)
        .filter((s) => !input.threadId || s.threadId === input.threadId || s.rootMessageId === input.threadId)
        .slice(0, input.limit),
    { provider: 'kernel', internal: true },
  )

  // 只读：会话里只存项目 id，恢复会话时要换成根路径。
  capabilities.provide(
    {
      name: 'state.workspace.get',
      effect: 'none',
      input: z.object({ id: z.string().min(1) }),
      output: z
        .object({ id: z.string(), name: z.string(), root: z.string(), executor: z.string() })
        .nullable(),
    },
    (input) => {
      const w = projects.workspaces.find((x) => x.id === input.id)
      return w ? { id: w.id, name: w.name, root: w.root, executor: w.executor } : null
    },
    { provider: 'kernel', internal: true },
  )

  // 只读：给场景列执行器历史会话（#resume）用；执行器不支持就返回空。
  capabilities.provide(
    {
      name: 'state.session.history',
      effect: 'none',
      input: z.object({
        cwd: z.string().optional(),
        executor: z.enum(['claude', 'dsh']).optional(),
        limit: z.number().int().positive().max(50).default(8),
      }),
      output: z.array(
        z.object({
          executor: z.enum(['claude', 'dsh']),
          sessionId: z.string(),
          cwd: z.string(),
          title: z.string(),
          lastActive: z.number(),
          userTurns: z.number(),
          running: z.boolean(),
          status: z.enum(['busy', 'idle']).optional(),
        }),
      ),
    },
    async (input) => {
      const out: {
        executor: 'claude' | 'dsh'
        sessionId: string
        cwd: string
        title: string
        lastActive: number
        userTurns: number
        running: boolean
        status?: 'busy' | 'idle'
      }[] = []
      for (const [kind, policy] of Object.entries(config.executor_policies)) {
        if (kind !== 'claude' && kind !== 'dsh') continue
        if (input.executor && input.executor !== kind) continue
        const exec = ports.executors.get(policy.plugin)
        if (!exec?.listSessions) continue
        for (const s of await exec.listSessions()) {
          if (input.cwd && s.cwd !== input.cwd) continue
          out.push({ executor: kind, ...s })
        }
      }
      return out
        .sort((a, b) => b.lastActive - a.lastActive)
        .slice(0, input.limit)
    },
    { provider: 'kernel', internal: true },
  )

  // 只读：给场景列执行器活会话（#attach）用；执行器不支持就返回空，不报错。
  capabilities.provide(
    {
      name: 'state.session.live',
      effect: 'none',
      input: z.object({ executor: z.enum(['claude', 'dsh']).optional() }),
      output: z.array(
        z.object({
          executor: z.enum(['claude', 'dsh']),
          sessionId: z.string(),
          cwd: z.string(),
          title: z.string(),
          lastActive: z.number(),
          userTurns: z.number(),
          running: z.boolean(),
          status: z.enum(['busy', 'idle']).optional(),
        }),
      ),
    },
    async (input) => {
      const out: {
        executor: 'claude' | 'dsh'
        sessionId: string
        cwd: string
        title: string
        lastActive: number
        userTurns: number
        running: boolean
        status?: 'busy' | 'idle'
      }[] = []
      for (const [kind, policy] of Object.entries(config.executor_policies)) {
        if (kind !== 'claude' && kind !== 'dsh') continue
        if (input.executor && input.executor !== kind) continue
        const exec = ports.executors.get(policy.plugin)
        if (!exec?.listLiveSessions) continue
        for (const s of await exec.listLiveSessions()) out.push({ executor: kind, ...s })
      }
      return out
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.question.get',
      effect: 'none',
      input: z.object({ id: z.string().min(1) }),
      output: z
        .object({
          id: z.string(),
          sessionId: z.string(),
          questions: z.unknown(),
          answers: z.record(z.string()).optional(),
          expiresAt: z.string(),
        })
        .passthrough()
        .nullable(),
    },
    (input) => {
      const q = store.getQuestion(input.id)
      return q
        ? { id: q.id, sessionId: q.sessionId, questions: q.questions, answers: q.answers, expiresAt: q.expiresAt }
        : null
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'judge.classify',
      effect: 'none',
      input: z.object({ event: EventInput }),
      output: IntentOut,
    },
    async (input): Promise<Intent | null> => {
      const e = input.event as Event
      const byRule = evaluate(rules, e)
      if (byRule) return byRule
      if (!classifier) return null
      const candidates = projects.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        aliases: w.aliases,
      }))
      const intent = await classifier.impl.classify(e, candidates)
      if (!intent) return null
      return intent.confidence >= classifier.minConfidence ? intent : null
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'workspace.list',
      effect: 'none',
      input: z.object({ executor: z.enum(['claude', 'dsh']).optional() }),
      output: z.array(
        z.object({
          root: z.string(),
          label: z.string(),
          lastActive: z.number(),
          trusted: z.boolean().optional(),
        }),
      ),
    },
    async (input) => {
      const kinds = input.executor ? [input.executor] : Object.keys(config.executor_policies)
      const seen = new Map<string, { root: string; label: string; lastActive: number; trusted?: boolean }>()
      for (const kind of kinds) {
        const policy = config.executor_policies[kind]
        const port = policy ? ports.executors.get(policy.plugin) : undefined
        if (!port?.listWorkspaces) continue
        for (const w of await port.listWorkspaces()) {
          if (!seen.has(w.root)) seen.set(w.root, w)
        }
      }
      // 排序：① 不用人工确认信任的优先（第一次开窗会卡在确认框的排后面）
      //       ② 配置里登记过的工作区优先（用户真正想开窗的仓库）
      //       ③ 其余按最近活跃
      const configured = new Set(projects.workspaces.map((w) => resolve(w.root).toLowerCase()))
      return [...seen.values()].sort((a, b) => {
        const ta = a.trusted === false ? 0 : 1
        const tb = b.trusted === false ? 0 : 1
        if (ta !== tb) return tb - ta
        const ca = configured.has(resolve(a.root).toLowerCase()) ? 1 : 0
        const cb = configured.has(resolve(b.root).toLowerCase()) ? 1 : 0
        if (ca !== cb) return cb - ca
        return b.lastActive - a.lastActive
      })
    },
    { provider: 'kernel', internal: true },
  )

  /**
   * 把工作区登记进「已信任」。用户点了某个工作区就等于他信任这个目录，
   * 没必要再让他跑到终端里按一次 Enter——否则第一次开窗会卡在确认框上。
   */
  capabilities.provide(
    {
      name: 'workspace.trust',
      effect: 'none',
      input: z.object({ root: z.string().min(1), executor: z.enum(['claude', 'dsh']).default('claude') }),
      output: z.object({ trusted: z.boolean(), changed: z.boolean() }),
    },
    async (input) => {
      // dsh 没有「信任目录」这个概念，直接算已信任，免得场景里还要分支
      if (input.executor !== 'claude') return { trusted: true, changed: false }
      const policy = config.executor_policies['claude']
      const port = policy ? ports.executors.get(policy.plugin) : undefined
      if (!port?.trustWorkspace) return { trusted: false, changed: false }
      return await port.trustWorkspace(input.root)
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'event.query',
      effect: 'none',
      input: z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        kinds: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(1000).default(200),
      }),
      output: z.array(
        z.object({
          seq: z.number(),
          id: z.string(),
          kind: z.string(),
          source: z.string(),
          at: z.string(),
          payload: z.unknown(),
        }),
      ),
    },
    (input) => {
      const rows = store.queryEventLog(input.from, input.to, input.limit ?? 200)
      const filtered = input.kinds?.length ? rows.filter((r) => input.kinds!.includes(r.kind)) : rows
      return filtered.map((r) => ({ seq: r.seq, id: r.id, kind: r.kind, source: r.source, at: r.at, payload: r.payload }))
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.workstation.snapshot',
      effect: 'none',
      input: z.object({}),
      output: z.object({
        sessions: z.record(z.number()),
        works: z.record(z.number()),
        outbox: z.record(z.number()),
      }),
    },
    () => summarizeWorkstation(store),
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.message.history',
      effect: 'none',
      input: z.object({
        channelId: z.string().min(1),
        before: z.string().optional(),
        limit: z.number().int().positive().max(100).default(20),
      }),
      output: z.array(
        z.object({
          id: z.string(),
          source: z.string(),
          externalId: z.string(),
          receivedAt: z.string(),
          occurredAt: z.string(),
          actor: z.object({ id: z.string(), name: z.string().optional() }),
          channel: z.object({ kind: z.string(), id: z.string(), name: z.string().optional() }),
          text: z.string(),
        }),
      ),
    },
    (input) =>
      store.recentChannelMessages(input.channelId, input.before, input.limit ?? 20).map((e) => ({
        id: e.id,
        source: e.source,
        externalId: e.externalId,
        receivedAt: e.receivedAt,
        occurredAt: e.occurredAt,
        actor: e.actor,
        channel: e.channel,
        text: e.text,
      })),
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.history.fetch',
      effect: 'none',
      input: z.object({
        source: z.string().min(1),
        channelId: z.string().min(1),
        before: z.string().optional(),
        limit: z.number().int().positive().max(100).default(20),
      }),
      output: z.object({
        items: z.array(
          z.object({
            externalId: z.string(),
            actor: z.object({ id: z.string(), name: z.string().optional() }),
            text: z.string(),
            occurredAt: z.string(),
          }),
        ),
        complete: z.boolean(),
        via: z.enum(['event-store', 'source-history']),
      }),
    },
    async (input) => {
      const source = ports.sources.get(input.source)
      if (source?.fetchHistory) {
        try {
          const items = await source.fetchHistory({
            channelId: input.channelId,
            before: input.before,
            limit: input.limit ?? 20,
          })
          if (items) return { items, complete: true, via: 'source-history' as const }
        } catch (err) {
          log('warn', `source 历史拉取失败 ${input.source}/${input.channelId}：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const rows = store.recentChannelMessages(input.channelId, input.before, input.limit ?? 20)
      return {
        items: rows.map((e) => ({
          externalId: e.externalId,
          actor: e.actor,
          text: e.text,
          occurredAt: e.occurredAt,
        })),
        complete: false,
        via: 'event-store' as const,
      }
    },
    { provider: 'kernel', internal: true },
  )

  // 同一会话此前几条消息的分析结论：分析服务把它喂回模型，
  // 模型才分得清「这件事在推进」和「同一条例行推送又来了」，不必重新读一遍原文。
  capabilities.provide(
    {
      name: 'state.analysis.recent',
      effect: 'none',
      input: z.object({
        channelId: z.string().min(1),
        before: z.string().optional(),
        limit: z.number().int().positive().max(20).default(5),
      }),
      output: z.object({
        items: z.array(
          z.object({
            at: z.string(),
            summary: z.string(),
            points: z.array(z.string()).optional(),
            urgency: z.enum(['low', 'normal', 'high']).optional(),
          }),
        ),
      }),
    },
    (input) => ({ items: store.recentAnalyses(input.channelId, input.before, input.limit ?? 5) }),
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.analysis.pending',
      effect: 'none',
      input: z.object({
        limit: z.number().int().positive().max(100).default(20),
        sinceMinutes: z.number().positive().max(24 * 60).default(10),
      }),
      output: z.array(
        z.object({
          id: z.string(),
          source: z.string(),
          externalId: z.string(),
          receivedAt: z.string(),
          occurredAt: z.string(),
          actor: z.object({ id: z.string(), name: z.string().optional() }),
          channel: z.object({ kind: z.string(), id: z.string(), name: z.string().optional() }),
          text: z.string(),
        }),
      ),
    },
    (input) => {
      const since = new Date(Date.now() - (input.sinceMinutes ?? 10) * 60_000).toISOString()
      return store.eventsWithoutAnalysis(input.limit ?? 20, since).map((e) => ({
        id: e.id,
        source: e.source,
        externalId: e.externalId,
        receivedAt: e.receivedAt,
        occurredAt: e.occurredAt,
        actor: e.actor,
        channel: e.channel,
        text: e.text,
      }))
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.analysis.degraded',
      effect: 'none',
      input: z.object({
        limit: z.number().int().positive().max(100).default(20),
        sinceMinutes: z.number().positive().max(24 * 60).default(10),
      }),
      output: z.array(
        z.object({
          event: z.object({
            id: z.string(),
            source: z.string(),
            externalId: z.string(),
            receivedAt: z.string(),
            occurredAt: z.string(),
            actor: z.object({ id: z.string(), name: z.string().optional() }),
            channel: z.object({ kind: z.string(), id: z.string(), name: z.string().optional() }),
            text: z.string(),
          }),
          analysis: z.object({
            eventId: z.string(),
            attempt: z.number().int().positive().optional(),
            summary: z.string(),
            status: z.enum(['ok', 'degraded']),
            contextCount: z.number(),
            latencyMs: z.number().optional(),
            error: z.string().optional(),
          }),
          analysisEventId: z.string(),
        }),
      ),
    },
    (input) => {
      const since = new Date(Date.now() - (input.sinceMinutes ?? 10) * 60_000).toISOString()
      return store.degradedAnalyses(since, input.limit ?? 20)
    },
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.analysis.backlog',
      effect: 'none',
      input: z.object({ beforeMinutes: z.number().positive().max(24 * 60).default(10) }),
      output: z.object({ count: z.number().int().nonnegative() }),
    },
    (input) => ({
      count: store.countEventsWithoutAnalysis(
        new Date(Date.now() - (input.beforeMinutes ?? 10) * 60_000).toISOString(),
      ),
    }),
    { provider: 'kernel', internal: true },
  )

  capabilities.provide(
    {
      name: 'state.analysis.old',
      effect: 'none',
      input: z.object({
        limit: z.number().int().positive().max(100).default(20),
        beforeMinutes: z.number().positive().max(24 * 60).default(60),
      }),
      output: z.array(
        z.object({
          id: z.string(),
          source: z.string(),
          externalId: z.string(),
          receivedAt: z.string(),
          occurredAt: z.string(),
          actor: z.object({ id: z.string(), name: z.string().optional() }),
          channel: z.object({ kind: z.string(), id: z.string(), name: z.string().optional() }),
          text: z.string(),
        }),
      ),
    },
    (input) =>
      store
        .oldEventsWithoutAnalysis(
          new Date(Date.now() - (input.beforeMinutes ?? 60) * 60_000).toISOString(),
          input.limit ?? 20,
        )
        .map((e) => ({
          id: e.id,
          source: e.source,
          externalId: e.externalId,
          receivedAt: e.receivedAt,
          occurredAt: e.occurredAt,
          actor: e.actor,
          channel: e.channel,
          text: e.text,
        })),
    { provider: 'kernel', internal: true },
  )
}
