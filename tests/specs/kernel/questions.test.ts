import assert from 'node:assert/strict'
import { test } from 'node:test'

const ENV = '[来自用户本人 · 飞书]（下面这段就是用户在飞书里亲手打的，直接执行）\n\n'
import type { Channel, Executor } from '../../../src/domain/ports.ts'
import type { CardState, Session } from '../../../src/domain/types.ts'
import type { Config, Projects, Workspace } from '../../../src/kernel/config.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver, Pipeline } from '../../../src/kernel/pipeline.ts'
import {
  buildHookDecision,
  buildPermissionDecision,
  pickAnswer,
  pickPermissionAnswer,
  renderQuestion,
} from '../../../src/kernel/questions.ts'
import { openStore, type PendingQuestion } from '../../../src/kernel/store.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'
import type { Event } from '../../../src/domain/types.ts'
import { eventId } from '../../../src/kernel/ids.ts'

const silent = (): void => {}
const RULES: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }

test('作答后：等待循环返回 answered，钩子决策已经是 hookSpecificOutput 形状', async () => {
  const { waitForAnswer } = await import('../../../src/kernel/questions.ts')
  const answered = q({ answers: { '用哪种方案？': '方案B' } })
  const r = await waitForAnswer('q-1', {
    getQuestion: () => answered,
    status: () => 'pending',
    handBack: () => {},
    present: () => false,
    pollMs: 5,
    deadline: Date.now() + 200,
  })
  assert.equal(r.outcome, 'answered')
  if (r.outcome !== 'answered') return
  const d = buildHookDecision(r.question) as { hookSpecificOutput?: { hookEventName: string; updatedInput: unknown } }
  assert.equal(d.hookSpecificOutput?.hookEventName, 'PreToolUse')
  assert.deepEqual(
    (d.hookSpecificOutput?.updatedInput as { answers: Record<string, string> }).answers,
    { '用哪种方案？': '方案B' },
  )
})

function q(over: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    id: 'q-1',
    questions: [
      {
        question: '用哪种方案？',
        header: '方案',
        options: [{ label: '方案A' }, { label: '方案B' }, { label: '方案C', description: '更慢但稳' }],
      },
    ],
    answers: {},
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...over,
  }
}

test('选择题：回序号解析成选项文案，key 是问题原文', () => {
  assert.deepEqual(pickAnswer(q(), '2'), { question: '用哪种方案？', answer: '方案B' })
  assert.deepEqual(pickAnswer(q(), '#3'), { question: '用哪种方案？', answer: '方案C' })
  assert.deepEqual(pickAnswer(q(), '随便你定'), { question: '用哪种方案？', answer: '随便你定' }, '自由作答照收')
  assert.deepEqual(pickAnswer(q(), '9'), { question: '用哪种方案？', answer: '9' }, '超出范围的数字当自由作答')
})

test('选择题：多选才合并，单选只取第一个', () => {
  const multi = q({
    questions: [{ question: '要哪些？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }],
  })
  assert.deepEqual(pickAnswer(multi, '1,3'), { question: '要哪些？', answer: 'A, C' })
  assert.deepEqual(pickAnswer(q(), '1,3'), { question: '用哪种方案？', answer: '方案A' })
})

test('选择题：多题时按顺序答，已答的题不再重复问', () => {
  const two = q({
    questions: [
      { question: '第一题？', options: [{ label: 'x' }, { label: 'y' }] },
      { question: '第二题？', options: [{ label: 'z' }, { label: 'w' }] },
    ],
  })
  assert.deepEqual(pickAnswer(two, '2'), { question: '第一题？', answer: 'y' })
  const afterFirst = { ...two, answers: { '第一题？': 'y' } }
  assert.deepEqual(pickAnswer(afterFirst, '1'), { question: '第二题？', answer: 'z' })
  assert.match(renderQuestion(afterFirst), /第二题？[\s\S]*第 2\/2 题/)
})

test('选择题：钩子决策包在 hookSpecificOutput 里（顶层平铺 Claude 不认）', () => {
  const answered = { ...q(), answers: { '用哪种方案？': '方案B' } }
  const d = buildHookDecision(answered) as {
    hookSpecificOutput: {
      hookEventName: string
      permissionDecision: string
      updatedInput: { answers: Record<string, string>; questions: unknown[] }
    }
  }
  assert.equal(d.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(d.hookSpecificOutput.permissionDecision, 'allow')
  assert.deepEqual(d.hookSpecificOutput.updatedInput.answers, { '用哪种方案？': '方案B' })
  assert.equal(d.hookSpecificOutput.updatedInput.questions.length, 1)
  assert.equal((d as Record<string, unknown>)['permissionDecision'], undefined, '不能再平铺在顶层')
  assert.deepEqual(buildHookDecision(q()), {}, '没答案就什么都不返回，终端弹窗照常出现')
})

function ws(): Workspace {
  return {
    id: 'personal-lingcub',
    name: '个人 · 幺幺零',
    kind: 'repo',
    root: 'E:\\Develop_E\\lingcub',
    executor: 'claude',
    isolation: 'worktree',
    concurrency: 1,
    freshSession: true,
    aliases: ['lingcub'],
  }
}
const projects = (): Projects => ({ workspaces: [ws()] })
function cfg(): Config {
  return {
    mode: 'auto',
    log: { level: 'info' },
    store: { path: ':memory:' },
    sources: {},
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
    classifiers: { llm: { plugin: 'classifier-llm', prompt: 'p.md', minConfidence: 0.3 } },
    executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\Develop_E'] } },
    limits: { maxConcurrentSessions: 2, maxSessionMB: 80 },
  } as Config
}
function session(): Session {
  const t = '2026-11-03T10:00:00.000Z'
  return {
    id: 'sess-1',
    chatId: 'oc_1',
    threadId: 'om_root',
    title: '修订单分页',
    executor: 'claude',
    workspace: 'personal-lingcub',
    sessionId: 'exec-1',
    status: 'active',
    createdAt: t,
    lastActiveAt: t,
  }
}
function ev(text: string): Event {
  return {
    id: eventId('source-feishu-im', 'om_ans'),
    source: 'source-feishu-im',
    externalId: 'om_ans',
    receivedAt: '2026-11-03T10:01:00.000Z',
    occurredAt: '2026-11-03T10:01:00.000Z',
    actor: { id: 'ou_1' },
    channel: { kind: 'group', id: 'oc_1' },
    threadId: 'om_root',
    text,
    raw: {},
  }
}

test('有题在等答案时，话题里的回复是答案，不会投进窗口', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    store.insertQuestion({
      id: 'q-1',
      sessionId: 'sess-1',
      questions: q().questions,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    let posted = 0
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
    }
    const executor: Executor = {
      async start() {
        return { executor: 'claude', sessionId: 'x', workspace: 'w' }
      },
      async read() {
        return []
      },
      async stop() {},
      async post() {
        posted++
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports,
      sessions: store,
      log: silent,
    })

    assert.equal(await pipeline.ingest(ev('2')), 'queued')
    assert.equal(store.getQuestion('q-1')?.answers['用哪种方案？'], '方案B')
    await outbox.tick()
    assert.equal(posted, 0, '答案不该被当成新消息投给窗口')
    const reply = store.listOutbox('done')[0]
    assert.ok(reply, '应回一条「已记录」')
  } finally {
    store.close()
  }
})

test('没有待答题时，话题消息照常投给窗口', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    let posted: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
    }
    const executor: Executor = {
      async start() {
        return { executor: 'claude', sessionId: 'x', workspace: 'w' }
      },
      async read() {
        return []
      },
      async stop() {},
      async post(_h, text) {
        posted.push(text)
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports,
      sessions: store,
      log: silent,
    })
    assert.equal(await pipeline.ingest(ev('把导出按钮加上')), 'posted')
    await outbox.tick()
    assert.deepEqual(posted, [ENV + '把导出按钮加上'])
  } finally {
    store.close()
  }
})

test('工具授权：文字只认整行 1/2（自由文字分不清是回答还是新指令）', () => {
  assert.deepEqual(pickPermissionAnswer('1'), { behavior: 'allow' })
  assert.deepEqual(pickPermissionAnswer('2'), { behavior: 'deny' })
  assert.deepEqual(pickPermissionAnswer('1 总是'), { behavior: 'allow', always: true })
  // 下面这些**不该**被当成授权：随手说的「允许」可能是别的意思
  assert.equal(pickPermissionAnswer('允许'), null)
  assert.equal(pickPermissionAnswer('yes'), null)
  assert.equal(pickPermissionAnswer('1 你看一下这个'), null)
  assert.equal(pickPermissionAnswer('随便'), null)
})

test('工具授权：决策形状按官方契约，allow 必须原样回传 tool_input', () => {
  const toolInput = { command: 'rm -rf build' }
  const allow = buildPermissionDecision({ decision: 'allow' }, toolInput) as any
  assert.equal(allow.hookSpecificOutput.hookEventName, 'PermissionRequest')
  assert.equal(allow.hookSpecificOutput.decision.behavior, 'allow')
  assert.deepEqual(allow.hookSpecificOutput.decision.updatedInput, toolInput)

  const always = buildPermissionDecision({ decision: 'allow', always: '1' }, toolInput) as any
  assert.equal(always.hookSpecificOutput.decision.updatedPermissions[0].behavior, 'allow')

  const deny = buildPermissionDecision({ decision: 'deny' }, toolInput) as any
  assert.equal(deny.hookSpecificOutput.decision.behavior, 'deny')
  assert.match(deny.hookSpecificOutput.decision.message, /拒绝/)

  assert.deepEqual(buildPermissionDecision({}, toolInput), {}, '没答案就不代答')
})

test('工具授权：话题里的 1/2 变成决策，不会投给窗口', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    store.insertQuestion({
      id: 'perm-1',
      sessionId: 'sess-1',
      questions: [],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: 'permission',
    })
    let posted = 0
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
    }
    const executor: Executor = {
      async start() {
        return { executor: 'claude', sessionId: 'x', workspace: 'w' }
      },
      async read() {
        return []
      },
      async stop() {},
      async post() {
        posted++
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports,
      sessions: store,
      log: silent,
    })
    assert.equal(await pipeline.ingest(ev('1')), 'queued')
    assert.equal(store.getQuestion('perm-1')?.answers['decision'], 'allow')
    await outbox.tick()
    assert.equal(posted, 0)
  } finally {
    store.close()
  }
})

test('工具授权：回 2 就是拒绝（不能一律放行）', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    store.insertQuestion({
      id: 'perm-2',
      sessionId: 'sess-1',
      questions: [],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: 'permission',
    })
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
    }
    const executor: Executor = {
      async start() {
        return { executor: 'claude', sessionId: 'x', workspace: 'w' }
      },
      async read() {
        return []
      },
      async stop() {},
      async post() {},
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports,
      sessions: store,
      log: silent,
    })
    assert.equal(await pipeline.ingest(ev('2')), 'queued')
    assert.equal(store.getQuestion('perm-2')?.answers['decision'], 'deny')
    await outbox.tick()
    const reply = store.listOutbox('done')[0]?.action
    assert.match(reply?.kind === 'reply_only' ? reply.text : '', /已拒绝/)
  } finally {
    store.close()
  }
})

test('选择题卡片：点选项直接作答；点失效的卡按原因回不同文案', async () => {
  const { openStore } = await import('../../../src/kernel/store.ts')
  const { Outbox } = await import('../../../src/kernel/outbox.ts')
  const { Pipeline } = await import('../../../src/kernel/pipeline.ts')
  const { createDeliver } = await import('../../../src/kernel/runtime.ts').catch(() => ({ createDeliver: undefined }))
  void createDeliver
  const store = openStore(':memory:')
  try {
    const sent: string[] = []
    const outbox = new Outbox(store, async (a) => {
      if (a.kind === 'reply_only') sent.push(a.text)
    })
    const cfg = {
      mode: 'auto',
      sessions: { newTopicPolicy: 'open', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 60_000 },
      executor_policies: {},
      rules: [],
      channels: {},
      sources: {},
      classifiers: {},
      autoReply: { enabled: false, pollSeconds: 5, cooldownSeconds: 60, policies: [] },
      cleanup: { enabled: false },
      contextWindow: 200_000,
    } as never
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg,
      projects: { workspaces: [] },
      rules: { rules: [] } as never,
      ports: { sources: new Map(), classifiers: new Map(), executors: new Map(), channels: new Map() } as never,
      sessions: store,
      log: (() => {}) as never,
    })

    store.insertQuestion({
      id: 'q1',
      sessionId: 's1',
      questions: [{ question: '用哪个方案？', options: [{ label: '甲' }, { label: '乙' }] }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    const click = (value: Record<string, unknown>, id: string) => ({
      id,
      source: 'source-feishu-card',
      externalId: id,
      receivedAt: new Date().toISOString(),
      occurredAt: new Date().toISOString(),
      actor: { id: 'ou_1' },
      channel: { kind: 'group' as const, id: 'oc_1' },
      rootId: 'om_root',
      text: JSON.stringify(value),
      raw: { type: 'card.action.trigger', event_id: id, chat_id: 'oc_1' },
    })

    await pipeline.ingest(click({ k: 'ans', qid: 'q1', n: 1, label: '乙' }, 'evt-1'))
    assert.equal(store.getQuestion('q1')?.answers['用哪个方案？'], '乙', '点按钮就该记成答案')

    // 再点一次同一张卡：已经答过，不覆盖
    await pipeline.ingest(click({ k: 'ans', qid: 'q1', n: 0, label: '甲' }, 'evt-2'))
    await outbox.tick()
    assert.equal(store.getQuestion('q1')?.answers['用哪个方案？'], '乙', '不能把已答的答案改掉')
    assert.ok(sent.some((t) => t.includes('已经答过了')), `应该提示已答过，实际：${sent.join(' | ')}`)

    // 交还终端之后又点选项：不能再被当成答案（这一类只有状态能判出来）
    store.insertQuestion({
      id: 'q2',
      sessionId: 's1',
      questions: [{ question: '继续吗？', options: [{ label: '继续' }] }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await pipeline.ingest(click({ k: 'hands', qid: 'q2' }, 'evt-3'))
    assert.equal(store.questionStatus('q2'), 'hands', '点交还后状态要变')
    await pipeline.ingest(click({ k: 'ans', qid: 'q2', n: 0, label: '继续' }, 'evt-4'))
    await outbox.tick()
    assert.equal(store.getQuestion('q2')?.answers['继续吗？'], undefined, '交还终端后不能再被卡片答掉')
    assert.ok(sent.some((t) => t.includes('你自己点了')), `要说明是自己点了交还，实际：${sent.join(' | ')}`)
  } finally {
    store.close()
  }
})

test('多选题：点按钮先攒着（可取消），点「就这些」才提交', async () => {
  const { openStore } = await import('../../../src/kernel/store.ts')
  const { Outbox } = await import('../../../src/kernel/outbox.ts')
  const { Pipeline } = await import('../../../src/kernel/pipeline.ts')
  const store = openStore(':memory:')
  try {
    const sent: string[] = []
    const outbox = new Outbox(store, async (a) => {
      if (a.kind === 'reply_only') sent.push(a.text)
    })
    const cfg = {
      mode: 'auto',
      sessions: { newTopicPolicy: 'open', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 60_000 },
      executor_policies: {},
      channels: {},
      sources: {},
      classifiers: {},
      auto_reply: { enabled: false, pollSeconds: 5, cooldownSeconds: 60, policies: [] },
      cleanup: { enabled: false },
      contextWindow: 200_000,
    } as never
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg,
      projects: { workspaces: [] },
      rules: { rules: [] } as never,
      ports: { sources: new Map(), classifiers: new Map(), executors: new Map(), channels: new Map() } as never,
      sessions: store,
      log: (() => {}) as never,
    })
    store.insertQuestion({
      id: 'q-multi',
      sessionId: 's1',
      questions: [{ question: '改哪几个？', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }] }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    const click = (value: Record<string, unknown>, id: string) => ({
      id,
      source: 'source-feishu-card',
      externalId: id,
      receivedAt: new Date().toISOString(),
      occurredAt: new Date().toISOString(),
      actor: { id: 'ou_1' },
      channel: { kind: 'group' as const, id: 'oc_1' },
      rootId: 'om_root',
      text: JSON.stringify(value),
      raw: { type: 'card.action.trigger', event_id: id, chat_id: 'oc_1' },
    })

    // 点甲、点丙：都只是攒着，不提交
    await pipeline.ingest(click({ k: 'ans', qid: 'q-multi', label: '甲' }, 'e1'))
    await pipeline.ingest(click({ k: 'ans', qid: 'q-multi', label: '丙' }, 'e2'))
    assert.equal(store.getQuestion('q-multi')?.answers['改哪几个？'], undefined, '没点「就这些」之前不能算答完')
    assert.deepEqual(store.getDraft('q-multi')['改哪几个？'], ['甲', '丙'])

    // 再点丙 = 取消
    await pipeline.ingest(click({ k: 'ans', qid: 'q-multi', label: '丙' }, 'e3'))
    assert.deepEqual(store.getDraft('q-multi')['改哪几个？'], ['甲'])

    // 提交
    await pipeline.ingest(click({ k: 'ansok', qid: 'q-multi' }, 'e4'))
    assert.equal(store.getQuestion('q-multi')?.answers['改哪几个？'], '甲', '提交时把攒的拼成答案')
    await outbox.tick()
    assert.ok(sent.some((t) => t.includes('已提交：甲')), `要回一句已提交，实际：${sent.join(' | ')}`)

    // 交完之后再点一次「就这些」：不能被当成再交一次
    await pipeline.ingest(click({ k: 'ansok', qid: 'q-multi' }, 'e5'))
    await outbox.tick()
    assert.equal(store.getQuestion('q-multi')?.answers['改哪几个？'], '甲', '答案不能被后续点击改掉')
    assert.ok(sent.some((t) => t.includes('已经不在了')), `要说清这道题已经没了，实际：${sent.join(' | ')}`)
  } finally {
    store.close()
  }
})

test('分段限流：按 1 秒一段排开，到点前不出队', async () => {
  const { openStore } = await import('../../../src/kernel/store.ts')
  const { Outbox } = await import('../../../src/kernel/outbox.ts')
  const store = openStore(':memory:')
  try {
    const sent: string[] = []
    const outbox = new Outbox(store, async (a) => {
      if (a.kind === 'post_message') sent.push(a.text)
    })
    const now = Date.now()
    outbox.enqueue({ kind: 'post_message', sessionId: 's1', text: '第一段' }, 'k0')
    outbox.enqueue({ kind: 'post_message', sessionId: 's1', text: '第二段' }, 'k1', { notBefore: now + 1000 })
    outbox.enqueue({ kind: 'post_message', sessionId: 's1', text: '第三段' }, 'k2', { notBefore: now + 2000 })

    await outbox.tick()
    assert.deepEqual(sent, ['第一段'], '只发到点的那一段')

    await new Promise((r) => setTimeout(r, 1100))
    await outbox.tick()
    assert.deepEqual(sent, ['第一段', '第二段'], '1 秒后才发第二段')
  } finally {
    store.close()
  }
})

test('等作答：人回到电脑前立刻交还，等太久落 timeout 而不是「答过了」', async () => {
  const { waitForAnswer } = await import('../../../src/kernel/questions.ts')
  const q = {
    id: 'q1',
    sessionId: 's1',
    questions: [{ question: '用哪个？', options: [{ label: '甲' }] }],
    answers: {} as Record<string, string>,
    status: 'pending' as string,
    createdAt: '2026-11-03T10:00:00.000Z',
    expiresAt: '2026-11-03T11:00:00.000Z',
  }
  const mk = (over: Partial<typeof q> = {}) => ({ ...q, ...over })

  // ① 第 3 秒探到人回来了 → 交还，且原因要说清
  let clock = 0
  let handedBack: string | undefined
  const r1 = await waitForAnswer('q1', {
    getQuestion: () => mk(),
    status: () => 'pending',
    handBack: (_id, why) => {
      handedBack = why
    },
    present: () => clock >= 3_000,
    now: () => clock,
    sleep: async () => {
      clock += 500
    },
    probeMs: 3_000,
    deadline: 60_000,
  })
  assert.deepEqual(r1, { outcome: 'handback', why: 'present' })

  // ② 一直没人 → 到点落 timeout（不是 answerQuestion）
  clock = 0
  handedBack = undefined
  const r2 = await waitForAnswer('q1', {
    getQuestion: () => mk(),
    status: () => 'pending',
    handBack: (_id, why) => {
      handedBack = why
    },
    present: () => false,
    now: () => clock,
    sleep: async () => {
      clock += 500
    },
    probeMs: 3_000,
    deadline: 5_000,
  })
  assert.deepEqual(r2, { outcome: 'handback', why: 'timeout' })
  assert.equal(handedBack, 'timeout', '到点要写 timeout，不能假装答过了')

  // ③ 有人答了 → 返回决策
  const r3 = await waitForAnswer('q1', {
    getQuestion: () => mk({ answers: { '用哪个？': '甲' } }),
    status: () => 'answered',
    handBack: () => {},
    present: () => false,
    now: () => 0,
    sleep: async () => {},
    deadline: 1_000,
  })
  assert.equal(r3.outcome, 'answered')
})

test('权限卡：四个按钮 + 详细入参摘取 + 点按钮即作答', async () => {
  const { buildPermissionCard, permissionDetail } = await import('../../../src/kernel/questions.ts')

  // 摘字段：命令 400 字、描述 200 字、文件/路径/地址
  assert.deepEqual(permissionDetail({ command: 'pnpm test' }), ['`pnpm test`'])
  assert.deepEqual(permissionDetail({ file_path: 'E:\\a.ts', path: 'E:\\b.ts' }), ['文件：`E:\\a.ts`'])
  assert.deepEqual(permissionDetail({ path: 'E:\\b.ts' }), ['路径：`E:\\b.ts`'])
  const json = permissionDetail({ foo: 1 })
  assert.match(json[0] ?? '', /```[\s\S]*foo[\s\S]*```/, '认不出的工具就贴 JSON')

  const card = buildPermissionCard('perm-1', { tool_name: 'Bash', tool_input: { command: 'ls' } }, {
    chatId: 'oc_1',
    workspace: 'E:\\w',
  }) as { kind: string; toolName: string; detail: string[] }
  assert.equal(card.kind, 'permission')
  assert.equal(card.toolName, 'Bash')
  assert.deepEqual(card.detail, ['`ls`'])
})

test('权限卡按钮：允许/总是/拒绝 都写进待答记录，重复点击不重复作答', async () => {
  const { openStore } = await import('../../../src/kernel/store.ts')
  const { Outbox } = await import('../../../src/kernel/outbox.ts')
  const { Pipeline } = await import('../../../src/kernel/pipeline.ts')
  const store = openStore(':memory:')
  try {
    const sent: string[] = []
    const outbox = new Outbox(store, async (a) => {
      if (a.kind === 'reply_only') sent.push(a.text)
    })
    const cfg2 = {
      mode: 'auto',
      sessions: { newTopicPolicy: 'open', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 60_000 },
      executor_policies: {},
      channels: {},
      sources: {},
      classifiers: {},
      auto_reply: { enabled: false, pollSeconds: 5, cooldownSeconds: 60, policies: [] },
      cleanup: { enabled: false },
      contextWindow: 200_000,
    } as never
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg2,
      projects: { workspaces: [] },
      rules: { rules: [] } as never,
      ports: { sources: new Map(), classifiers: new Map(), executors: new Map(), channels: new Map() } as never,
      sessions: store,
      log: (() => {}),
    } as never)
    store.insertQuestion({
      id: 'perm-1',
      sessionId: 's1',
      questions: [],
      kind: 'permission',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const click = (v: Record<string, unknown>, id: string) => ({
      id,
      source: 'source-feishu-card',
      externalId: id,
      receivedAt: new Date().toISOString(),
      occurredAt: new Date().toISOString(),
      actor: { id: 'ou_1' },
      channel: { kind: 'group' as const, id: 'oc_1' },
      rootId: 'om_root',
      text: JSON.stringify(v),
      raw: { type: 'card.action.trigger', event_id: id, chat_id: 'oc_1' },
    })

    await pipeline.ingest(click({ k: 'perm', qid: 'perm-1', d: 'allow', always: true }, 'e1'))
    await outbox.tick()
    assert.deepEqual(store.getQuestion('perm-1')?.answers, { decision: 'allow', always: '1' })
    assert.ok(sent.some((t) => t.includes('本会话不再问')))

    // 再点一次：不能把已定的决定改掉
    await pipeline.ingest(click({ k: 'perm', qid: 'perm-1', d: 'deny' }, 'e2'))
    await outbox.tick()
    assert.deepEqual(store.getQuestion('perm-1')?.answers, { decision: 'allow', always: '1' })
    assert.ok(sent.some((t) => t.includes('已经处理过')))
  } finally {
    store.close()
  }
})
