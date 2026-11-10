/**
 * 本地窗口采纳：claude 与 dsh 两种执行器。
 *
 * 这里只碰纯内存路径与临时目录（不读真实的 ~/.dsh），
 * 验证「谁被采纳、记成哪个 executor/source、每轮合计上限、dead 复活、子代理不采纳」。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import type { Channel, Executor } from '../../../src/domain/ports.ts'
import type { Session } from '../../../src/domain/types.ts'
import type { Config, Projects } from '../../../src/kernel/config.ts'
import { createDeliver, localSessionId, Pipeline } from '../../../src/kernel/pipeline.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import { createDshExecutor, headerInfo, isUserWindowHeader, type DshConfig } from '../../../src/plugin-kit/dsh-executor.ts'

const silent = (): void => {}

const CLAUDE_SESSION = 'aaaaaaaa-1111-2222-3333-444444444444'
const DSH_SESSION = 'bbbbbbbb-1111-2222-3333-444444444444'

function cfg(over: { sessions?: Record<string, unknown>; policies?: string[] } = {}): Config {
  const policies = over.policies ?? ['claude', 'dsh']
  const executor_policies: Record<string, { plugin: string; allowRoots: string[] }> = {}
  if (policies.includes('claude')) executor_policies.claude = { plugin: 'executor-claude', allowRoots: ['E:\\Develop_E'] }
  if (policies.includes('dsh')) executor_policies.dsh = { plugin: 'executor-dsh', allowRoots: ['E:\\Develop_E'] }
  return {
    mode: 'auto',
    log: { level: 'info' },
    store: { path: ':memory:' },
    sources: {},
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1', pinCards: true } },
    classifiers: { llm: { plugin: 'classifier-llm', prompt: 'p.md', minConfidence: 0.3 } },
    executor_policies,
    limits: { maxConcurrentSessions: 2, maxSessionMB: 80 },
    sessions: { adoptLocalWindows: true, adoptPerRun: 5, ...over.sessions },
  } as Config
}

const projects = (): Projects => ({ workspaces: [] })

function session(over: Partial<Session> = {}): Session {
  const t = '2026-11-09T02:00:00.000Z'
  return {
    id: 'sess-1',
    chatId: 'oc_1',
    title: '窗口',
    executor: 'claude',
    workspace: 'E:\\ws\\proj-a',
    sessionId: CLAUDE_SESSION,
    status: 'active',
    createdAt: t,
    lastActiveAt: t,
    ...over,
  }
}

/** 两个执行器各报一条活会话；传 undefined 表示这个执行器不实现 listLiveSessions。 */
function env(live: { claude?: unknown[]; dsh?: unknown[] }) {
  const cards: { card: unknown; pin?: boolean }[] = []
  const pins: [string, boolean][] = []
  const channel: Channel = {
    async send() {
      return { status: 'sent', messageId: 'om_x' }
    },
    async sendCard(a: { card: unknown; pin?: boolean }) {
      cards.push({ card: a.card, pin: a.pin })
      return { status: 'sent', messageId: 'om_topic_root' }
    },
    async patchCard() {},
    async pinMessage(id: string, pin: boolean) {
      pins.push([id, pin])
    },
    async threadIdOf() {
      return 'omt_topic_real'
    },
  }
  // 两个执行器插件都装上（真实配置里也都在），没给活会话的那个就报空
  const executors = new Map<string, Executor>([
    ['executor-claude', { async listLiveSessions() { return (live.claude ?? []) as never } } as Executor],
    ['executor-dsh', { async listLiveSessions() { return (live.dsh ?? []) as never } } as Executor],
  ])
  const ports: Ports = {
    sources: new Map(),
    classifiers: new Map(),
    executors,
    channels: new Map([['channel-feishu', channel]]),
  }
  return { ports, cards, pins }
}

function makePipeline(config: Config, ports: Ports, store: ReturnType<typeof openStore>) {
  const outbox = new Outbox(store, createDeliver({ ports, config, projects: projects(), store, log: silent }))
  const pipeline = new Pipeline({
    store,
    outbox,
    config,
    projects: projects(),
    rules: { rules: [] } as never,
    ports,
    sessions: store,
    log: silent,
    transcripts: () => undefined,
  } as never)
  return {
    pipeline,
    outbox,
    adopt: (pipeline as unknown as { adoptLocalWindows: () => Promise<number> }).adoptLocalWindows.bind(pipeline),
  }
}

test('dsh 活会话会被采纳：executor=dsh、source=source-local-dsh，卡片当话题根并置顶', async () => {
  const store = openStore(':memory:')
  try {
    const e = env({ dsh: [{ sessionId: DSH_SESSION, cwd: 'E:\\ws\\proj-b', running: true }] })
    const { adopt, outbox } = makePipeline(cfg(), e.ports, store)
    assert.equal(await adopt(), 1, 'dsh 窗口要能接进来')
    const adopted = store.findSessionByExecutor(DSH_SESSION)
    assert.equal(adopted?.executor, 'dsh', '投递要按 dsh 端口走')
    assert.equal(adopted?.source, 'source-local-dsh')
    assert.equal(adopted?.workspace, 'E:\\ws\\proj-b', 'workspace 取窗口 cwd')
    assert.equal(adopted?.title, 'proj-b', '没标题时取 cwd 末段（沿用 claude 规则）')
    assert.equal(adopted?.chatId, 'oc_1')
    assert.equal(await adopt(), 0, '同一个 dsh 会话只接一次')
    await outbox.tick()
    assert.equal(e.cards.length, 1, '一个窗口一张卡')
    // 置顶由内核统一做（频道不再自己顺手钉，否则 pin 失败也会被记成成功）
    assert.deepEqual(e.pins, [['om_topic_root', true]], '这张卡要置顶（同时是话题根）')
    assert.equal((e.cards[0]?.card as { title?: string }).title, 'proj-b')
  } finally {
    store.close()
  }
})

test('claude 行为不变：executor=claude、source=source-local-claude', async () => {
  const store = openStore(':memory:')
  try {
    const e = env({ claude: [{ sessionId: CLAUDE_SESSION, cwd: 'E:\\ws\\proj-a', title: 'proj-a', running: true }] })
    const { adopt } = makePipeline(cfg(), e.ports, store)
    assert.equal(await adopt(), 1)
    const adopted = store.findSessionByExecutor(CLAUDE_SESSION)
    assert.equal(adopted?.executor, 'claude')
    assert.equal(adopted?.source, 'source-local-claude')
    assert.equal(adopted?.title, 'proj-a')
  } finally {
    store.close()
  }
})

test('adoptPerRun 对两种执行器合计生效：上限 1 时一轮只接 1 个，下一轮再接另一个', async () => {
  const store = openStore(':memory:')
  try {
    const e = env({
      claude: [{ sessionId: CLAUDE_SESSION, cwd: 'E:\\ws\\proj-a', running: true }],
      dsh: [{ sessionId: DSH_SESSION, cwd: 'E:\\ws\\proj-b', running: true }],
    })
    const { adopt } = makePipeline(cfg({ sessions: { adoptPerRun: 1 } }), e.ports, store)
    assert.equal(await adopt(), 1, '两个执行器合起来也只有 1 个名额')
    assert.ok(store.findSessionByExecutor(CLAUDE_SESSION), '先扫 claude')
    assert.equal(store.findSessionByExecutor(DSH_SESSION), null, 'dsh 排到下一轮')
    assert.equal(await adopt(), 1, '下一轮接 dsh')
    assert.ok(store.findSessionByExecutor(DSH_SESSION))
    assert.equal(await adopt(), 0, '都接完了')
  } finally {
    store.close()
  }
})

test('已存在的 dsh 会话被标过 dead：窗口还活着就复活成 active', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(
      session({
        id: 'sess-local-bbbbbbbb',
        executor: 'dsh',
        sessionId: DSH_SESSION,
        source: 'source-local-dsh',
        status: 'dead',
        workspace: 'E:\\ws\\proj-b',
        lastActiveAt: '2026-11-09T01:00:00.000Z',
      }),
    )
    const e = env({ dsh: [{ sessionId: DSH_SESSION, cwd: 'E:\\ws\\proj-b', running: true }] })
    const { adopt } = makePipeline(cfg(), e.ports, store)
    assert.equal(await adopt(), 0, '认识的窗口不重复接')
    const revived = store.getSession('sess-local-bbbbbbbb')
    assert.equal(revived?.status, 'active', '活着的 dsh 窗口要复活，否则置顶一直被撤')
    assert.notEqual(revived?.lastActiveAt, '2026-11-09T01:00:00.000Z', '顺带刷活跃时间，别被立刻判死')
  } finally {
    store.close()
  }
})

test('配置里只有 claude 时不影响采纳（没配 dsh 策略不该把这一轮打挂）', async () => {
  const store = openStore(':memory:')
  try {
    const e = env({ claude: [{ sessionId: CLAUDE_SESSION, cwd: 'E:\\ws\\proj-a', running: true }] })
    const { adopt } = makePipeline(cfg({ policies: ['claude'] }), e.ports, store)
    assert.equal(await adopt(), 1)
  } finally {
    store.close()
  }
})

test('session 头判定：子代理/编排会话不是用户窗口，判定不出来也不采纳', () => {
  const user = { type: 'session', version: 4, id: 'x', cwd: 'E:\\Develop_E\\lingcub', agentPreset: 'yue' }
  assert.equal(isUserWindowHeader(JSON.stringify(user)), true, '普通会话就是用户窗口')
  assert.equal(isUserWindowHeader(JSON.stringify({ ...user, parentSession: '' })), true, 'parentSession 空串等于没有')
  // 程序化 headless 会话（TongClaw 任务）与用户窗口只差这一处：没有 agentPreset
  assert.equal(
    isUserWindowHeader(JSON.stringify({ type: 'session', version: 4, id: 'task', cwd: 'E:\\ws' })),
    false,
    '没有 agentPreset = 程序化会话，不能当用户窗口',
  )
  assert.equal(isUserWindowHeader(JSON.stringify({ ...user, agentPreset: '' })), false, '空串等于没有')
  assert.equal(
    isUserWindowHeader(JSON.stringify({ ...user, origin: 'subagent', parentSession: 'session-7ae71de9', delegationDepth: 1 })),
    false,
    'origin=subagent 是子代理会话',
  )
  assert.equal(isUserWindowHeader(JSON.stringify({ ...user, parentSession: 'session-7ae71de9' })), false, '有 parentSession 就是子代理')
  assert.equal(isUserWindowHeader('not json'), false, '坏 JSON 判定不出来 → 不采纳')
  assert.equal(isUserWindowHeader('{}'), false, '缺头 → 不采纳')
  assert.equal(isUserWindowHeader(JSON.stringify({ type: 'message', text: 'hi' })), false, '首行不是 session 头 → 不采纳')
  // createdAt 是「是不是刚开的窗口」的依据：翻旧会话也会被写，只有创建时间能区分
  assert.equal(headerInfo(JSON.stringify({ ...user, createdAt: 1794204636361 })).createdAt, 1794204636361)
  assert.equal(headerInfo(JSON.stringify(user)).createdAt, undefined, '没有 createdAt 就别瞎猜')
})

/** 临时 ~/.dsh：写一份会话缓存 + 一份转录（zstd），让 discoverDshSessions 能扫到。 */
function writeDshSession(home: string, id: string, cwd: string, header: string | undefined): void {
  const cacheDir = join(home, '.dsh', 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, `${id}.json`),
    JSON.stringify({ version: 1, record: { identity: { cwd }, rows: { title: { val: `窗口-${id.slice(0, 4)}` } } } }),
  )
  const dir = join(home, '.dsh', 'sessions', 'proj', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  // header 为 undefined 时写坏数据：解压失败 = 判定不出来
  writeFileSync(file, header === undefined ? 'not-zstd' : zstdCompressSync(Buffer.from(`${header}\n{"type":"message"}\n`)))
}

test('dsh listLiveSessions 剔除子代理会话，读不出头的也不采纳', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lingcub-dsh-live-'))
  const oldUser = process.env.USERPROFILE
  const oldHome = process.env.HOME
  try {
    process.env.USERPROFILE = home
    process.env.HOME = home
    const ws = 'E:\\ws\\proj-a'
    const userWindow = { type: 'session', version: 4, id: 'userwin', cwd: ws, agentPreset: 'yue' }
    const subagent = { type: 'session', version: 4, id: 'subagent', cwd: ws, origin: 'subagent', parentSession: 'session-7ae71de9', delegationDepth: 1 }
    writeDshSession(home, 'userwin-1111', ws, JSON.stringify(userWindow))
    writeDshSession(home, 'subagent-2222', ws, JSON.stringify(subagent))
    writeDshSession(home, 'broken-3333', ws, undefined)
    const dsh: DshConfig = {
      binary: 'dsh',
      allowRoots: ['E:\\ws'],
      args: ['--profile', 'headless', '--json', '{{prompt}}'],
      timeoutMs: 1000,
      postArgs: ['--profile', 'headless', '--json', '--session-id', '{{sessionId}}', '-'],
      postTimeoutMs: 1000,
      resumeDays: 5,
      liveWindowMs: 90_000,
    }
    const live = await createDshExecutor(dsh, silent).listLiveSessions?.()
    assert.deepEqual(live?.map((s) => s.sessionId), ['userwin-1111'], '只留用户自己开的窗口')
  } finally {
    process.env.USERPROFILE = oldUser
    process.env.HOME = oldHome
  }
})

test('dsh 会话被扫到就刷新活跃时间：别因为「没说话」被标 idle 再撤掉置顶', async () => {
  // 2026-11-09：本会话在跑工具、只是没发消息，半小时后被判 idle → 置顶被撤 → 扫到又复活 → 置顶补回，来回抖
  const store = openStore(':memory:')
  try {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString()
    store.insertSession(
      session({
        id: 'sess-local-cccccccc',
        executor: 'dsh',
        sessionId: DSH_SESSION,
        source: 'source-local-dsh',
        status: 'active',
        workspace: 'E:\\ws\\proj-b',
        lastActiveAt: threeHoursAgo,
      }),
    )
    const e = env({ dsh: [{ sessionId: DSH_SESSION, cwd: 'E:\\ws\\proj-b', running: true, createdAt: Date.now() - 60_000 }] })
    await makePipeline(cfg(), e.ports, store).adopt()
    const after = store.findSessionByExecutor(DSH_SESSION)
    assert.ok(
      after && Date.parse(after.lastActiveAt) > Date.now() - 60_000,
      `扫到还在动的 dsh 会话就要刷新活跃时间（现在 ${after?.lastActiveAt}）`,
    )
  } finally {
    store.close()
  }
})

test('dsh 老会话被翻开写一行也不算新窗口：只有刚建的才接进飞书', async () => {
  // 2026-11-09：两个 11-04 / 13:30 建的会话被写了一次，就被当成「刚打开的窗口」刷出两个话题
  const store = openStore(':memory:')
  try {
    const stale = env({
      dsh: [{ sessionId: DSH_SESSION, cwd: 'E:\\ws\\proj-b', running: true, createdAt: Date.now() - 3 * 3600_000 }],
    })
    assert.equal(await makePipeline(cfg(), stale.ports, store).adopt(), 0, '三小时前建的会话不该被当成刚打开的窗口')

    const fresh = env({
      dsh: [{ sessionId: 'session-brandnew', cwd: 'E:\\ws\\proj-b', running: true, createdAt: Date.now() - 60_000 }],
    })
    assert.equal(await makePipeline(cfg(), fresh.ports, store).adopt(), 1, '刚建的会话要接进来')
  } finally {
    store.close()
  }
})

test('会话短 id：dsh 的 session- 前缀不能把 id 吃掉（否则所有 dsh 窗口撞成一个）', () => {
  assert.equal(localSessionId('c510e321-4f0a-402a-a796-402bd5e25264'), 'sess-local-c510e321')
  assert.equal(localSessionId('session-7ae71de9-ba4f-4565-92c9-53cffdf3601c'), 'sess-local-7ae71de9')
  assert.notEqual(
    localSessionId('session-7ae71de9-ba4f-4565-92c9-53cffdf3601c'),
    localSessionId('session-db64f7d5-f67c-42cf-9a5a-c245be6582f6'),
    '两个 dsh 窗口必须是两个会话',
  )
})
