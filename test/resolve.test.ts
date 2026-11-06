import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Event, Intent } from '../src/domain/types.ts'
import { eventId } from '../src/kernel/ids.ts'
import type { Config, Projects, Workspace } from '../src/kernel/config.ts'
import { findWorkspace, resolveWork } from '../src/routing/resolve.ts'

function cfg(over: Partial<Config> = {}): Config {
  return {
    mode: 'auto',
    log: { level: 'info' },
    store: { path: ':memory:' },
    sources: {},
    channels: {},
    classifiers: {},
    executor_policies: {
      claude: { allowRoots: ['E:\\Develop_E\\tt'] },
      dsh: { allowRoots: ['E:\\Develop_E\\lingcub'], defaultBudgetUsd: 2 },
    },
    limits: { maxConcurrentSessions: 2, maxSessionMB: 80 },
    ...over,
  }
}

function workspace(over: Partial<Workspace> = {}): Workspace {
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

function projects(...ws: Workspace[]): Projects {
  return { workspaces: ws }
}

function ev(): Event {
  return {
    id: eventId('feishu-im', 'm1'),
    source: 'feishu-im',
    externalId: 'm1',
    receivedAt: '2026-11-03T09:00:00.000Z',
    occurredAt: '2026-11-03T08:59:00.000Z',
    actor: { id: 'u1', name: 'Yue' },
    channel: { kind: 'group', id: 'g1', name: '研发群' },
    text: '帮我把导出按钮加上',
    raw: {},
  }
}

function intent(over: Partial<Intent> = {}): Intent {
  return {
    eventId: eventId('feishu-im', 'm1'),
    kind: 'dev-request',
    topic: '加导出按钮',
    project: 'lingcub',
    suggestedAction: 'dispatch_session',
    rationale: '规则 group-at-me 命中',
    confidence: 0.95,
    byRule: 'group-at-me',
    ...over,
  }
}

test('门禁拒绝：工作区不在执行器 allowRoots 内时抛错，不产出 Work', () => {
  const c = cfg({ executor_policies: { dsh: { allowRoots: ['E:\\Other'] } } })
  assert.throws(() => resolveWork(intent(), ev(), { config: c, projects: projects(workspace()) }), /不在允许根内/)
})

test('门禁放宽后同一输入产出 Work（证明上一条是门禁在拦）', () => {
  const c = cfg({ executor_policies: { dsh: { allowRoots: ['E:\\Develop_E'], defaultBudgetUsd: 2 } } })
  const r = resolveWork(intent(), ev(), { config: c, projects: projects(workspace()) })
  assert.equal(r.kind, 'work')
  if (r.kind !== 'work') return
  assert.equal(r.work.workspace, 'E:\\Develop_E\\lingcub')
  assert.equal(r.work.executor, 'dsh')
  assert.equal(r.work.budgetUsd, 2)
  assert.equal(r.work.status, 'queued')
  assert.equal(r.work.intentId, intent().eventId)
})

test('observe 档只记录：不产出 Work，也不做门禁', () => {
  const c = cfg({ mode: 'observe', executor_policies: { dsh: { allowRoots: [] } } })
  assert.deepEqual(resolveWork(intent(), ev(), { config: c, projects: projects(workspace()) }), {
    kind: 'observe',
  })
})

test('auto 档置信度不足只跳过，不入队', () => {
  const c = cfg({ mode: 'auto' })
  const r = resolveWork(intent({ confidence: 0.5 }), ev(), { config: c, projects: projects(workspace()) })
  assert.equal(r.kind, 'skip')
  if (r.kind !== 'skip') return
  assert.match(r.reason, /置信度/)
})

test('suggest 档不受置信度门槛限制，但仍产出待确认的 Work', () => {
  const c = cfg({ mode: 'suggest' })
  assert.equal(resolveWork(intent({ confidence: 0.4 }), ev(), { config: c, projects: projects(workspace()) }).kind, 'work')
})

test('项目缺失或匹配不上 → 跳过并说明原因，不乱派', () => {
  const c = cfg()
  const missing = resolveWork(intent({ project: undefined }), ev(), { config: c, projects: projects(workspace()) })
  assert.equal(missing.kind, 'skip')
  const unknown = resolveWork(intent({ project: '不存在的项目' }), ev(), { config: c, projects: projects(workspace()) })
  assert.equal(unknown.kind, 'skip')
  if (unknown.kind !== 'skip') return
  assert.match(unknown.reason, /未匹配到工作区/)
})

test('不需要执行器的意图不产出 Work', () => {
  const c = cfg()
  const r = resolveWork(intent({ suggestedAction: 'reply_only' }), ev(), { config: c, projects: projects(workspace()) })
  assert.equal(r.kind, 'skip')
})

test('项目别名可命中工作区', () => {
  assert.equal(findWorkspace(projects(workspace()), '幺幺零')?.id, 'personal-lingcub')
  assert.equal(findWorkspace(projects(workspace()), 'LINGCUB')?.id, 'personal-lingcub')
  assert.equal(findWorkspace(projects(workspace()), 'unknown'), undefined)
})

test('prompt 带上原文、来源与伞形工作区的路由提示', () => {
  const c = cfg({ executor_policies: { claude: { allowRoots: ['E:\\Develop_E\\tt'], defaultBudgetUsd: 3 } } })
  const ws = workspace({
    id: 'tt-design-space',
    kind: 'umbrella',
    root: 'E:\\Develop_E\\tt\\tt-design-space-ai',
    executor: 'claude',
    router: 'workspace/REPOSITORY-ROUTER.md',
  })
  const r = resolveWork(intent({ project: 'tt-design-space' }), ev(), { config: c, projects: projects(ws) })
  assert.equal(r.kind, 'work')
  if (r.kind !== 'work') return
  assert.match(r.work.prompt, /帮我把导出按钮加上/)
  assert.match(r.work.prompt, /feishu-im \/ 群聊 研发群/)
  assert.match(r.work.prompt, /REPOSITORY-ROUTER\.md/)
  assert.equal(r.work.executor, 'claude')
})
