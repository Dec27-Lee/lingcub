/** 控制台金标：固定输入 → IngestOutcome + 发件箱/会话/工作项快照。旧实现生成基线，新场景逐字比对。 */

import type { Channel, Classifier, Executor } from '../../../src/domain/ports.ts'
import type { Event, Intent, Progress, Work } from '../../../src/domain/types.ts'
import type { Config, Projects, Workspace } from '../../../src/kernel/config.ts'
import { eventId } from '../../../src/kernel/ids.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver, Pipeline } from '../../../src/kernel/pipeline.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const silent = (): void => {}
export const EMPTY_RULES: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }

export function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'personal-lingcub',
    name: '个人 · 幺幺零',
    kind: 'repo',
    root: 'E:\\Develop_E\\lingcub',
    executor: 'dsh',
    isolation: 'worktree',
    concurrency: 1,
    freshSession: true,
    aliases: ['lingcub', '幺幺零'],
    ...over,
  }
}

export function projects(): Projects {
  return { workspaces: [workspace()] }
}

export function cfg(over: Partial<Config> = {}): Config {
  return {
    mode: 'auto',
    log: { level: 'info' },
    store: { path: ':memory:' },
    sources: {},
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_test' } },
    classifiers: { llm: { plugin: 'classifier-llm', prompt: 'prompts/classify.md', minConfidence: 0.3 } },
    executor_policies: { dsh: { plugin: 'executor-dsh', allowRoots: ['E:\\Develop_E'] } },
    limits: { maxConcurrentSessions: 2, maxSessionMB: 80 },
    ...over,
  }
}

export function ev(externalId = 'om_1', over: Partial<Event> = {}): Event {
  return {
    id: eventId('source-feishu-im', externalId),
    source: 'source-feishu-im',
    externalId,
    receivedAt: '2026-11-03T09:00:00.000Z',
    occurredAt: '2026-11-03T08:59:00.000Z',
    actor: { id: 'ou_1' },
    channel: { kind: 'group', id: 'oc_1' },
    text: '登录页点导出报错 500',
    raw: {},
    ...over,
  }
}

export function intent(over: Partial<Intent> = {}): Intent {
  return {
    eventId: ev().id,
    kind: 'bug',
    topic: '导出报错 500',
    project: 'personal-lingcub',
    suggestedAction: 'dispatch_session',
    rationale: '给了具体故障现象',
    confidence: 0.9,
    ...over,
  }
}

export interface GoldenCase {
  name: string
  event: Event
  verdict: Intent | null
  mode?: 'auto' | 'observe' | 'suggest'
  rules?: Ruleset
  /** 预置库状态（如已绑定会话），在 ingest 前执行 */
  prep?: (store: ReturnType<typeof openStore>) => void
}

function fakeEnv(verdict: Intent | null): { ports: Ports; started: Work[]; sent: string[] } {
  const started: Work[] = []
  const sent: string[] = []
  const executor: Executor = {
    async start(w) {
      started.push(w)
      return { executor: 'dsh', sessionId: `s-${w.id}`, workspace: w.workspace }
    },
    async read(): Promise<Progress[]> {
      return []
    },
    async stop() {},
  }
  const channel: Channel = {
    async send(a) {
      sent.push(a.kind === 'reply_only' ? a.text : a.kind)
      return { status: 'sent', messageId: `om_${a.kind}` }
    },
    async sendCard() {
      return { status: 'sent', messageId: 'om_card' }
    },
  }
  const classifier: Classifier = {
    async classify() {
      return verdict
    },
  }
  const ports: Ports = {
    sources: new Map(),
    classifiers: new Map([['classifier-llm', classifier]]),
    executors: new Map([['executor-dsh', executor]]),
    channels: new Map([['channel-feishu', channel]]),
  }
  return { ports, started, sent }
}

function scrub(v: unknown): unknown {
  if (typeof v === 'string') {
    return v
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{20,}\b/gi, '<uuid>')
      .replace(/\bom_[\w-]+\b/g, 'om_<id>')
      .replace(/\bq-[\w-]+-\d+\b/g, 'q-<id>')
      .replace(/\bperm-[\w-]+-\d+\b/g, 'perm-<id>')
      .replace(/\b\d{10,}\b/g, '<ts>')
  }
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, scrub((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

export async function runCase(c: GoldenCase): Promise<unknown> {
  const config = cfg({ mode: c.mode ?? 'auto' })
  const store = openStore(':memory:')
  try {
    c.prep?.(store)
    const env = fakeEnv(c.verdict)
    const outbox = new Outbox(store, createDeliver({ ports: env.ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: c.rules ?? EMPTY_RULES,
      ports: env.ports,
      sessions: store,
      classifier: { impl: env.ports.classifiers.get('classifier-llm')!, minConfidence: 0.3 },
      log: silent,
    })
    const outcome = await pipeline.ingest(c.event)
    const tick = await outbox.tick()
    const rows = [
      ...store.listOutbox('done', 100).map((r) => ({ status: 'done', kind: r.action.kind, key: r.dedupeKey, action: r.action })),
      ...store.listOutbox('pending', 100).map((r) => ({ status: 'pending', kind: r.action.kind, key: r.dedupeKey, action: r.action })),
    ]
    const sessions = store.listSessions().map((s) => ({
      id: s.id,
      chatId: s.chatId,
      threadId: s.threadId,
      rootMessageId: s.rootMessageId,
      ownerId: s.ownerId,
      title: s.title,
      executor: s.executor,
      workspace: s.workspace,
      sessionId: s.sessionId,
      status: s.status,
    }))
    const works = (['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const).flatMap((st) =>
      store.listWorksByStatus(st).map((w) => ({ id: w.id, project: w.project, executor: w.executor, status: w.status })),
    )
    return scrub({ outcome, tick, rows, sessions, works })
  } finally {
    store.close()
  }
}
