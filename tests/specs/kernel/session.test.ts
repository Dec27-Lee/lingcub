import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

const ENV = '[来自用户本人 · 飞书]（下面这段就是用户在飞书里亲手打的，直接执行）\n\n'
import type { Channel, Classifier, Executor } from '../../../src/domain/ports.ts'
import type { Action, Event, Intent, Progress, Session, Work } from '../../../src/domain/types.ts'
import type { Config, Projects, Workspace } from '../../../src/kernel/config.ts'
import { eventId } from '../../../src/kernel/ids.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver, Pipeline } from '../../../src/kernel/pipeline.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'
import { routeToSession } from '../../../src/routing/session-route.ts'
import { deliverToPeer, findLivePeer } from '../../../src/plugin-kit/claude-pipe.ts'

const silent = (): void => {}
const EMPTY_RULES: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }

function ws(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'personal-lingcub',
    name: '个人 · 幺幺零',
    kind: 'repo',
    root: 'E:\\Develop_E\\lingcub',
    executor: 'dsh',
    isolation: 'worktree',
    concurrency: 1,
    freshSession: true,
    aliases: ['lingcub'],
    ...over,
  }
}
const projects = (): Projects => ({ workspaces: [ws()] })

function cfg(over: Partial<Config> = {}): Config {
  return {
    mode: 'auto',
    log: { level: 'info' },
    store: { path: ':memory:' },
    sources: {},
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
    classifiers: { llm: { plugin: 'classifier-llm', prompt: 'p.md', minConfidence: 0.3 } },
    executor_policies: { dsh: { plugin: 'executor-dsh', allowRoots: ['E:\\Develop_E'] } },
    limits: { maxConcurrentSessions: 2, maxSessionMB: 80 },
    ...over,
  }
}

function session(over: Partial<Session> = {}): Session {
  const t = '2026-11-03T10:00:00.000Z'
  return {
    id: 'sess-1',
    chatId: 'oc_1',
    threadId: 'om_root',
    title: '修一下订单分页',
    executor: 'dsh',
    workspace: 'personal-lingcub',
    sessionId: 'exec-1',
    status: 'active',
    createdAt: t,
    lastActiveAt: t,
    ...over,
  }
}

function ev(over: Partial<Event> & { chatId?: string; channelKind?: Event['channel']['kind'] } = {}): Event {
  const externalId = over.externalId ?? 'om_2'
  const { chatId, channelKind, ...rest } = over
  return {
    id: eventId('source-feishu-im', externalId),
    source: 'source-feishu-im',
    externalId,
    receivedAt: '2026-11-03T10:01:00.000Z',
    occurredAt: '2026-11-03T10:01:00.000Z',
    actor: { id: 'ou_1' },
    channel: { kind: channelKind ?? 'group', id: chatId ?? 'oc_1' },
    threadId: 'om_root',
    text: '把那列也加上',
    raw: {},
    ...rest,
    ...over,
  }
}

test('会话表：一个话题只绑一个会话', () => {
  const store = openStore(':memory:')
  try {
    assert.equal(store.insertSession(session()), true)
    assert.equal(store.insertSession(session({ id: 'sess-2' })), false, '同一话题插第二次应被唯一索引挡住')
    assert.equal(store.findSessionByThread('oc_1', 'om_root')?.id, 'sess-1')
    assert.equal(store.findSessionByThread('oc_1', 'om_other'), null)
  } finally {
    store.close()
  }
})

test('会话状态：touch 变 active，可置 dead；dead 不再接消息', () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session({ status: 'idle' }))
    store.touchSession('sess-1')
    assert.equal(store.getSession('sess-1')?.status, 'active')
    assert.equal(routeToSession(store, 'oc_1', 'om_root')?.id, 'sess-1')

    store.setSessionStatus('sess-1', 'dead')
    assert.equal(routeToSession(store, 'oc_1', 'om_root'), null, '死会话不该继续接消息')
    assert.equal(store.listSessions('dead').length, 1)
  } finally {
    store.close()
  }
})

test('会话路由：没有 threadId 就不路由（普通消息照常走判断）', () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    assert.equal(routeToSession(store, 'oc_1', undefined), null)
    assert.equal(routeToSession(store, 'oc_other', 'om_root'), null)
  } finally {
    store.close()
  }
})

test('事件记下投给了哪个会话（回放要能区分直投与判断）', () => {
  const store = openStore(':memory:')
  try {
    const e = ev()
    store.insertEvent(e)
    assert.equal(store.getEventSession(e.id), null)
    store.setEventSession(e.id, 'sess-1')
    assert.equal(store.getEventSession(e.id), 'sess-1')
  } finally {
    store.close()
  }
})

function fakeEnv() {
  const posted: { sessionId: string; text: string }[] = []
  const sent: string[] = []
  const executor: Executor = {
    async start(): Promise<{ executor: 'dsh'; sessionId: string; workspace: string }> {
      throw new Error('本测试不该起会话')
    },
    async read(): Promise<Progress[]> {
      return []
    },
    async stop(): Promise<void> {},
    async post(h, text): Promise<void> {
      posted.push({ sessionId: h.sessionId, text })
    },
  }
  const channel: Channel = {
    async send(a) {
      sent.push(a.kind === 'reply_only' ? a.text : a.kind)
      return { status: 'sent' }
    },
  }
  const classifier: Classifier = { async classify(): Promise<Intent | null> { return null } }
  const ports: Ports = {
    sources: new Map(),
    classifiers: new Map([['classifier-llm', classifier]]),
    executors: new Map([['executor-dsh', executor]]),
    channels: new Map([['channel-feishu', channel]]),
  }
  return { ports, posted, sent }
}

test('话题里的消息直投会话：不产生 Intent，也不起新会话', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const env = fakeEnv()
    const config = cfg()
    const outbox = new Outbox(store, createDeliver({ ports: env.ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: EMPTY_RULES,
      ports: env.ports,
      sessions: store,
      log: silent,
    })

    assert.equal(await pipeline.ingest(ev()), 'posted')
    assert.equal(store.countIntents(), 0, '直投不该留下判断')
    assert.equal(store.getEventSession(ev().id), 'sess-1')

    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.deepEqual(env.posted, [{ sessionId: 'exec-1', text: ENV + '把那列也加上' }])
    assert.equal(env.sent.length, 0, '投递是投进窗口，不是回飞书')
    assert.equal(store.getSession('sess-1')?.status, 'active')
  } finally {
    store.close()
  }
})

test('会话不支持追加时明确失败，不静默丢弃', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const env = fakeEnv()
    const noPost: Executor = {
      start: env.ports.executors.get('executor-dsh')!.start,
      read: async () => [],
      stop: async () => {},
    }
    const ports: Ports = { ...env.ports, executors: new Map([['executor-dsh', noPost]]) }
    const config = cfg()
    const outbox = new Outbox(store, createDeliver({ ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: EMPTY_RULES,
      ports,
      sessions: store,
      log: silent,
    })
    await pipeline.ingest(ev())
    const r = await outbox.tick()
    assert.deepEqual(r, { done: 0, failed: 1, dead: 0 }, '失败应回到 pending 重试（并最终走死信）')
    assert.equal(store.countOutbox('pending'), 1)
  } finally {
    store.close()
  }
})

test('命名管道投递：先 auth 行，再 user 信封行', { timeout: 20_000 }, async () => {
  const addr = process.platform === 'win32' ? `\\\\.\\pipe\\lingcub-test-${randomUUID()}` : `/tmp/lingcub-test-${randomUUID()}.sock`
  const lines: string[] = []
  const server: Server = createServer((socket) => {
    let buf = ''
    socket.on('data', (b: Buffer) => {
      buf += b.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
  })
  await new Promise<void>((r, j) => {
    server.once('error', j)
    server.listen(addr, () => r())
  })

  try {
    const result = await deliverToPeer({ socket: addr, token: 'peer-token-1', pid: 1 }, '把导出按钮加上', {
      closeDelayMs: 50,
      timeoutMs: 5000,
    })
    assert.deepEqual(result, { ok: true })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]!), { type: 'auth', token: 'peer-token-1' })
    assert.deepEqual(JSON.parse(lines[1]!), {
      type: 'user',
      message: { role: 'user', content: '把导出按钮加上' },
    })
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

function twoWs(): Projects {
  return {
    workspaces: [
      ws(),
      ws({ id: 'company-order', name: '公司 · 订单', root: 'E:\\Develop_E\\order', aliases: ['order'] }),
    ],
  }
}

function openEnv() {
  const started: Work[] = []
  const sentTexts: string[] = []
  const actions: Action[] = []
  const posted: { sessionId: string; text: string }[] = []
  const executor: Executor = {
    async start(w: Work) {
      started.push(w)
      return { executor: 'dsh', sessionId: `exec-${w.id}`, workspace: w.workspace }
    },
    async read(): Promise<Progress[]> {
      return []
    },
    async stop(): Promise<void> {},
    async post(h, text: string) {
      posted.push({ sessionId: h.sessionId, text })
    },
  }
  const channel: Channel = {
    async send(a) {
      actions.push(a)
      if (a.kind === 'reply_only') sentTexts.push(a.text)
      return { status: 'sent', messageId: `om_anchor_${sentTexts.length}` }
    },
    async sendCard(a) {
      actions.push({ kind: 'card_send', chatId: a.chatId, replyTo: a.replyTo, card: a.card })
      return { status: 'sent', messageId: `om_card_${actions.length}` }
    },
  }
  const ports: Ports = {
    sources: new Map(),
    classifiers: new Map(),
    executors: new Map([['executor-dsh', executor]]),
    channels: new Map([['channel-feishu', channel]]),
  }
  return { ports, started, sentTexts, actions, posted }
}

function openPipeline(store: ReturnType<typeof openStore>, ports: Ports, projects2: Projects) {
  const config = cfg({ sessions: { newTopicPolicy: 'open', choiceTtlMs: 60_000 } } as Partial<Config>)
  const outbox = new Outbox(store, createDeliver({ ports, config, projects: projects2, store, log: silent }))
  const pipeline = new Pipeline({
    store,
    outbox,
    config,
    projects: projects2,
    rules: EMPTY_RULES,
    ports,
    sessions: store,
    log: silent,
  })
  return { pipeline, outbox }
}

test('开窗：多个工作区先问，回序号后派工并绑话题', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())

    assert.equal(await pipeline.ingest(ev({ externalId: 'om_a', threadId: undefined, text: '修订单分页' })), 'queued')
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    // 选择卡上要有两个工作区的按钮（按钮文字带序号）
    const picker = env.actions.find((a) => a.kind === 'card_send')
    const card = picker?.kind === 'card_send' ? (picker.card as { kind?: string; options?: { id: string }[] }) : undefined
    assert.equal(card?.kind, 'picker')
    assert.deepEqual(card?.options?.map((o) => o.key), ['project:personal-lingcub', 'project:company-order'])

    assert.equal(await pipeline.ingest(ev({ externalId: 'om_b', threadId: undefined, text: '2' })), 'queued')
    // 锚消息由投递环节直接发（不占发件箱），发件箱里只有派工这一条
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.equal(env.started.length, 1)
    assert.equal(env.started[0]?.project, 'company-order')
    assert.equal(env.started[0]?.origin?.title, '修订单分页')

    const sessions = store.listSessions()
    assert.equal(sessions.length, 1)
    // 普通群（没有话题记忆）时才用锚消息当话题根；话题群里用用户那条消息
    assert.match(String(sessions[0]?.threadId), /^om_card_/, '没有话题 id 时锚消息（就绪卡）充当话题根')
    assert.equal(sessions[0]?.rootMessageId, 'om_a', '回复要回到用户发起的那条消息')
    assert.equal(sessions[0]?.sessionId, `exec-${env.started[0]!.id}`)
  } finally {
    store.close()
  }
})

test('开窗：只有一个工作区就不问，直接开', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, projects())
    assert.equal(await pipeline.ingest(ev({ externalId: 'om_c', threadId: undefined, text: '加导出' })), 'queued')
    await outbox.tick()
    assert.equal(env.started.length, 1)
    const anchor = env.actions.find((a) => a.kind === 'card_send')
    assert.equal(anchor?.kind === 'card_send' ? (anchor.card as { kind?: string }).kind : undefined, 'ready')
    assert.match(String((anchor?.card as { title?: string })?.title ?? ''), /窗口已创建：加导出/)
  } finally {
    store.close()
  }
})

test('开窗：序号不认就给选项重问，不误派工', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())
    await pipeline.ingest(ev({ externalId: 'om_d', threadId: undefined, text: '修订单分页' }))
    await outbox.tick()

    assert.equal(await pipeline.ingest(ev({ externalId: 'om_e', threadId: undefined, text: '随便' })), 'queued')
    await outbox.tick()
    assert.equal(env.started.length, 0, '认不出选择时不该派工')
    // 还没绑窗口：认不出选择就重问一遍选项（不是把「随便」当成任务）
    assert.match(env.sentTexts.at(-1) ?? '', /选工作区/)
  } finally {
    store.close()
  }
})

test('judge 档不走进开窗流程（默认行为不变）', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const config = cfg()
    const outbox = new Outbox(store, createDeliver({ ports: env.ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: EMPTY_RULES,
      ports: env.ports,
      sessions: store,
      log: silent,
    })
    assert.equal(await pipeline.ingest(ev({ externalId: 'om_f', threadId: undefined })), 'ignored')
    assert.equal(env.started.length, 0)
  } finally {
    store.close()
  }
})

test('开窗：已经在话题里的消息不开新窗（否则每个回复都变新窗口）', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())
    // 话题内回复（threadId + rootId）且没有会话绑定：属于「别人的话题」，不该开新窗
    const r = await pipeline.ingest(
      ev({ externalId: 'om_g', threadId: 'omt_topic', rootId: 'om_someone_else' }),
    )
    assert.equal(r, 'ignored')
    await outbox.tick()
    assert.equal(env.started.length, 0)
    assert.equal(store.countIntents(), 0)
  } finally {
    store.close()
  }
})

test('开窗：频道没返回消息 id 时明确失败，不建半截会话', async () => {
  const store = openStore(':memory:')
  try {
    const started: Work[] = []
    const executor: Executor = {
      async start(w: Work) {
        started.push(w)
        return { executor: 'dsh', sessionId: 'exec-x', workspace: w.workspace }
      },
      async read(): Promise<Progress[]> {
        return []
      },
      async stop(): Promise<void> {},
    }
    const channel: Channel = {
      async send() {
        return { status: 'sent' } // 没有 messageId
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-dsh', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const { pipeline, outbox } = openPipeline(store, ports, projects())
    await pipeline.ingest(ev({ externalId: 'om_h', threadId: undefined, text: '加导出' }))

    assert.deepEqual(await outbox.tick(), { done: 0, failed: 1, dead: 0 })
    // 先绑后宣告：会话行已经在（窗口真的起来了），但还没绑上话题——
    // 发件箱会重试，成功后才把话题 id 补上去。反过来做的话，
    // 「窗口已创建」已经发出、claude 立刻回 Stop 时会话查不到，结果被静默丢掉。
    const live = store.listSessions()
    assert.equal(live.length, 1, '窗口起来了就该有会话行（重试时要能接上）')
    assert.equal(live[0]?.threadId, undefined, '没拿到锚消息就没法绑话题')
    assert.equal(live[0]?.sessionId, 'exec-x')
  } finally {
    store.close()
  }
})

test('话题里的图片消息：入队时带上图片信息，正文换成[图片]', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const env = fakeEnv()
    const config = cfg()
    const outbox = new Outbox(store, createDeliver({ ports: env.ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: EMPTY_RULES,
      ports: env.ports,
      sessions: store,
      log: silent,
    })
    const e = ev({ externalId: 'om_img', text: '{"image_key":"img_88"}', imageKey: 'img_88' })
    assert.equal(await pipeline.ingest(e), 'posted')
    const action = store.listOutbox('pending')[0]?.action
    assert.equal(action?.kind, 'post_message')
    if (action?.kind === 'post_message') {
      assert.equal(action.text, '[图片]')
      assert.deepEqual(action.images, [{ messageId: 'om_img', fileKey: 'img_88' }])
    }
  } finally {
    store.close()
  }
})

test('管道查找：注册表存完整 uuid，用短 id 也要能命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-peer-'))
  const full = 'af74099e-2b7d-4a27-827d-9976f01a6b53'
  writeFileSync(
    join(dir, '52264.json'),
    JSON.stringify({ sessionId: full, pid: 52264, messagingSocketPath: '\\\\.\\pipe\\x', cwd: 'C:\\w' }),
  )
  writeFileSync(join(dir, '52264.abc.key'), JSON.stringify({ peerToken: 'tok-1' }))

  const byShort = findLivePeer(dir, 'af74099e')
  assert.equal(byShort?.token, 'tok-1', '短 id 应前缀命中')
  assert.equal(findLivePeer(dir, full)?.token, 'tok-1', '完整 id 精确命中')
  assert.equal(findLivePeer(dir, 'deadbeef'), null, '不存在的 id 不能瞎命中')
})

test('选工作区的提示必须回到用户那条话题里', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())
    const r = await pipeline.ingest(
      ev({ externalId: 'om_user_topic', threadId: 'omt_1', text: '把导出按钮加上' }),
    )
    assert.equal(r, 'queued')
    await outbox.tick()
    // 现在「问」的是一张带按钮的选择卡（不是回序号）
    const ask = env.actions.find((a) => a.kind === 'card_send')
    assert.equal(ask?.kind === 'card_send' ? ask.replyTo : undefined, 'om_user_topic', '要回复到用户那条消息所在话题')
    assert.equal(ask?.kind === 'card_send' ? ask.chatId : undefined, 'oc_1')
    const card = ask?.kind === 'card_send' ? (ask.card as { kind?: string }) : undefined
    assert.equal(card?.kind, 'picker', '应当是工作区选择卡')
  } finally {
    store.close()
  }
})

test('选工作区：话题里回「1」能被接住并开窗（不能被「话题内回复」挡掉）', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())
    // 1) 用户开新话题
    await pipeline.ingest(ev({ externalId: 'om_topic_root', threadId: 'omt_9', text: '把导出按钮加上' }))
    await outbox.tick()
    assert.equal(env.started.length, 0, '两个工作区时先问，不直接开窗')

    // 2) 用户在同一个话题里回「1」——这条带 rootId，仍然要被当成工作区回答
    await pipeline.ingest(
      ev({ externalId: 'om_topic_reply', threadId: 'omt_9', rootId: 'om_topic_root', text: '1' }),
    )
    await outbox.tick()
    assert.equal(env.started.length, 1, '应当按选择开出窗口')
    assert.equal(env.started[0]?.project, 'personal-lingcub')
  } finally {
    store.close()
  }
})

test('卡片回调（card.action.trigger）：点按钮就直接开窗，不用回序号', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())
    // 先制造一张待选卡（两个工作区 → 发选择卡）
    await pipeline.ingest(ev({ externalId: 'om_topic_root', threadId: 'omt_7', text: '把导出按钮加上' }))
    await outbox.tick()

    // 用户点了「2. order」按钮：回调事件没有 thread_id，话题信息在按钮 value 里
    const callback = ev({
      externalId: 'evt_card_1',
      source: 'source-feishu-card',
      threadId: undefined,
      rootId: undefined,
      text: JSON.stringify({
        k: 'pick',
        workspaceId: 'company-order',
        thread: 'omt_7',
        root: 'om_topic_root',
        chat: 'oc_1',
      }),
      raw: { type: 'card.action.trigger', event_id: 'evt_card_1', chat_id: 'oc_1' },
    })
    assert.equal(await pipeline.ingest(callback), 'queued')
    await outbox.tick()
    assert.equal(env.started.length, 1, '点按钮应当直接开窗')
    assert.equal(env.started[0]?.project, 'company-order')
    const session = store.listSessions()[0]
    assert.equal(session?.threadId, 'omt_7')
    assert.equal(session?.rootMessageId, 'om_topic_root')
  } finally {
    store.close()
  }
})

test('选择卡要列出执行器扫到的真实目录，不只是预设工作区', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    // 给执行器补上「扫描」能力：多出一个不在 projects.yaml 里的目录
    const exec = env.ports.executors.get('executor-dsh') as Executor & {
      listWorkspaces?: () => Promise<{ root: string; label: string; lastActive: number }[]>
    }
    exec.listWorkspaces = async () => [
      { root: 'E:\\Develop_E\\tt\\tt-design-space-ai', label: 'tt-design-space-ai', lastActive: 1 },
      { root: 'E:\\Develop_E\\lingcub', label: 'lingcub', lastActive: 2 },
    ]

    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())
    await pipeline.ingest(ev({ externalId: 'om_scan', threadId: 'omt_s', text: '加导出' }))
    await outbox.tick()

    const picker = env.actions.find((a) => a.kind === 'card_send')
    const card = picker?.kind === 'card_send' ? (picker.card as { options?: { key: string }[] }) : undefined
    const keys = card?.options?.map((o) => o.key) ?? []
    assert.ok(
      keys.some((k) => k.startsWith('root:E:\\Develop_E\\tt\\tt-design-space-ai')),
      `扫描到的目录要出现在选项里，实际：${keys.join(', ')}`,
    )
    assert.ok(
      !keys.some((k) => k === 'root:E:\\Develop_E\\lingcub'),
      '已经在预设里的目录不能重复出现',
    )
  } finally {
    store.close()
  }
})

test('#resume：新话题里发 #resume 会列出可恢复会话（运行中的不列）', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const exec = env.ports.executors.get('executor-dsh') as Executor & {
      listSessions?: () => Promise<{
        sessionId: string
        cwd: string
        title: string
        lastActive: number
        userTurns: number
        running: boolean
      }[]>
    }
    exec.listSessions = async () => [
      { sessionId: 'sess-a', cwd: 'E:\\Develop_E\\lingcub', title: '修分页', lastActive: 1, userTurns: 7, running: false },
      { sessionId: 'sess-b', cwd: 'E:\\Develop_E\\lingcub', title: '在跑的那个', lastActive: 2, userTurns: 3, running: true },
    ]
    const { pipeline, outbox } = openPipeline(store, env.ports, projects())
    assert.equal(
      await pipeline.ingest(ev({ externalId: 'om_resume', threadId: 'omt_r', text: '#resume' })),
      'queued',
    )
    await outbox.tick()
    const card = env.actions.find((a) => a.kind === 'card_send')
    const items = card?.kind === 'card_send' ? (card.card as { kind?: string; items?: { sessionId: string }[] }) : undefined
    assert.equal(items?.kind, 'resume')
    assert.deepEqual(items?.items?.map((i) => i.sessionId), ['sess-a'], '运行中的会话不能列出来')
  } finally {
    store.close()
  }
})

test('#resume：点卡片按钮 → 用 --resume 起一个接着历史会话的窗口', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, projects())
    const callback = ev({
      externalId: 'evt_resume_1',
      source: 'source-feishu-card',
      threadId: undefined,
      text: JSON.stringify({
        k: 'resume',
        sid: 'sess-abc',
        cwd: 'E:\\Develop_E\\lingcub',
        thread: 'omt_r',
        root: 'om_root_msg',
        chat: 'oc_1',
      }),
      raw: { type: 'card.action.trigger', event_id: 'evt_resume_1', chat_id: 'oc_1' },
    })
    assert.equal(await pipeline.ingest(callback), 'queued')
    await outbox.tick()
    assert.equal(env.started.length, 1)
    assert.equal(env.started[0]?.resumeSessionId, 'sess-abc')
    assert.equal(env.started[0]?.workspace, 'E:\\Develop_E\\lingcub')
  } finally {
    store.close()
  }
})

test('开窗：#别名 直接跳过选择卡，话题名用剩下的正文', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())
    assert.equal(
      await pipeline.ingest(ev({ externalId: 'om_alias', threadId: 'omt_al', text: '#order 修一下分页' })),
      'queued',
    )
    await outbox.tick()
    assert.equal(env.started.length, 1, '带别名就不用再问工作区')
    assert.equal(env.started[0]?.project, 'company-order')
    assert.equal(env.started[0]?.origin?.title, '修一下分页')
  } finally {
    store.close()
  }
})

test('#resume 在已绑定话题里 = 换会话：改绑而不是新开一条', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const exec = env.ports.executors.get('executor-dsh') as Executor & {
      listSessions?: () => Promise<{
        sessionId: string
        cwd: string
        title: string
        lastActive: number
        userTurns: number
        running: boolean
      }[]>
    }
    exec.listSessions = async () => [
      { sessionId: 'sess-old-1', cwd: 'E:\\Develop_E\\lingcub', title: '旧会话', lastActive: 9, userTurns: 5, running: false },
      { sessionId: 'sess-other', cwd: 'E:\\Develop_E\\order', title: '别的目录', lastActive: 8, userTurns: 5, running: false },
      // 目录已经被删/移走的会话恢复不了，不能列出来（点下去就是往不存在的目录里开窗）
      { sessionId: 'sess-gone', cwd: 'E:\\Develop_E\\lingcub\\personal-lingcub\\__gone__', title: '目录没了', lastActive: 9, userTurns: 5, running: false },
      { sessionId: 'sess-empty', cwd: 'E:\\Develop_E\\lingcub', title: '', lastActive: 9, userTurns: 0, running: false },
      { sessionId: 'sess-busy', cwd: 'E:\\Develop_E\\lingcub', title: '在跑的', lastActive: 9, userTurns: 5, running: true },
    ]
    // 已有一个活跃会话绑在 om_root 这个话题上
    store.insertSession(
      session({ id: 'sess-live', threadId: 'om_root', workspace: 'personal-lingcub', sessionId: 'exec-1' }),
    )
    const { pipeline, outbox } = openPipeline(store, env.ports, projects())

    await pipeline.ingest(ev({ externalId: 'om_switch', threadId: 'om_root', text: '#resume' }))
    await outbox.tick()
    const card = env.actions.find((a) => a.kind === 'card_send')
    const items = card?.kind === 'card_send' ? (card.card as { items?: { sessionId: string }[] }) : undefined
    assert.deepEqual(
      items?.items?.map((i) => i.sessionId),
      ['sess-old-1'],
      '只列同一工作区、目录还在、不是空会话的那些',
    )
    // 正在跑的同工作区会话进不了候选，但卡片要说清有几个没上场
    const note = card?.kind === 'card_send' ? (card.card as { note?: string }).note : undefined
    assert.match(note ?? '', /另有 1 个会话正在运行/)

    // 点选后：起新窗口 + 改绑同一行会话
    await pipeline.ingest(
      ev({
        externalId: 'evt_switch_1',
        source: 'source-feishu-card',
        threadId: undefined,
        text: JSON.stringify({
          k: 'resume',
          sid: 'sess-old-1',
          cwd: 'E:\\Develop_E\\lingcub',
          thread: 'om_root',
          root: 'om_root',
          rebind: 'sess-live',
        }),
        raw: { type: 'card.action.trigger', event_id: 'evt_switch_1', chat_id: 'oc_1' },
      }),
    )
    await outbox.tick()
    assert.equal(env.started.at(-1)?.resumeSessionId, 'sess-old-1')
    const after = store.getSession('sess-live')
    assert.equal(after?.sessionId, `exec-${env.started.at(-1)!.id}`, '话题改绑到新起的窗口')
    assert.equal(store.listSessions().length, 1, '不能多出一条会话')
  } finally {
    store.close()
  }
})

test('路由三级回退：引用桥接发过的消息 → 找回窗口', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    store.insertSession(
      session({ id: 'sess-q', threadId: 'omt_q', rootMessageId: 'om_root', sessionId: 'exec-q', executor: 'dsh' }),
    )
    // 模拟桥接发过一条消息（投递时写映射）
    store.mapMessage('om_bot_msg', 'sess-q', 'oc_1')

    const { pipeline, outbox } = openPipeline(store, env.ports, projects())
    // 群里的引用回复：没有 threadId、没有 rootId，只有 replyTo
    const r = await pipeline.ingest(
      ev({ externalId: 'om_quote', threadId: undefined, rootId: undefined, replyTo: 'om_bot_msg', text: '接着说' }),
    )
    assert.equal(r, 'posted', '引用命中 → 直接投进那个会话（posted）')
    await outbox.tick()
    assert.deepEqual(env.posted.map((p) => p.text), [ENV + '接着说'], '引用命中后要投进那个会话')
  } finally {
    store.close()
  }
})

test('路由三级回退：单聊里不引用也能投给最近 5 分钟聊过的窗口', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    store.insertSession(
      session({
        id: 'sess-dm',
        threadId: 'omt_dm',
        chatId: 'oc_dm',
        sessionId: 'exec-dm',
        executor: 'dsh',
        lastActiveAt: new Date().toISOString(),
      }),
    )
    const { pipeline, outbox } = openPipeline(store, env.ports, projects())
    const r = await pipeline.ingest(
      ev({ externalId: 'om_dm', threadId: undefined, rootId: undefined, chatId: 'oc_dm', channelKind: 'dm', text: '在吗' }),
    )
    assert.equal(r, 'posted', '单聊回退 → 直接投进最近那个窗口')
    await outbox.tick()
    assert.deepEqual(env.posted.map((p) => p.text), [ENV + '在吗'], '单聊没引用也要投给最近的窗口')
  } finally {
    store.close()
  }
})

test('#目录名 模糊匹配：写到一半的目录名也能选中；写错了不静默换别处', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())

    // 「lin」是 lingcub 的前半截：模糊命中
    await pipeline.ingest(ev({ externalId: 'om_f1', threadId: undefined, text: '#lin 加个导出' }))
    await outbox.tick()
    const w = env.started.at(-1)
    assert.ok(w, '模糊匹配应该直接起窗口')
    assert.equal(w?.origin?.title, '加个导出', '任务名取 # 后面那段')

    // 写错目录名：不能悄悄开在别的地方，要说明并列出候选
    const before = env.started.length
    await pipeline.ingest(ev({ externalId: 'om_f2', threadId: undefined, text: '#完全不存在 干活' }))
    await outbox.tick()
    assert.equal(env.started.length, before, '写错目录不该起窗口')
    assert.match(env.sentTexts.at(-1) ?? '', /没找到目录「完全不存在」/)
    // 也不该再弹一张选择卡（那等于问了两遍）
    const pickers = env.actions.filter(
      (a) => a.kind === 'card_send' && (a.card as { kind?: string }).kind === 'picker',
    )
    assert.equal(pickers.length, 0, '写错目录只说明并列出候选，不再弹选择卡')
  } finally {
    store.close()
  }
})

test('话题内消息查不到绑定：是我们自己开的窗口就明确回提示，不是就静默', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    // 频道能查「这条消息是不是机器人发的」：ownRoot 是，otherRoot 不是
    env.ports.channels.set('channel-feishu', {
      ...env.ports.channels.get('channel-feishu')!,
      async isOwnMessage(id: string) {
        return id === 'om_our_root'
      },
    })
    const { pipeline, outbox } = openPipeline(store, env.ports, twoWs())

    // ① 我们的窗口，但库里没绑定 → 必须回一句（不能静默吞掉，人以为发出去了）
    const r = await pipeline.ingest(
      ev({ externalId: 'om_1', threadId: 'omt_ours', rootId: 'om_our_root', text: '继续改剩下两个' }),
    )
    assert.equal(r, 'queued')
    await outbox.tick()
    const said = env.actions.filter((a) => a.kind === 'reply_only').map((a) => a.text).join('\n')
    assert.match(said, /没绑上窗口/)
    assert.match(said, /#resume/)
    assert.match(said, /#新窗/)

    // ② 别人的话题 → 照旧静默
    const r2 = await pipeline.ingest(
      ev({ externalId: 'om_2', threadId: 'omt_other', rootId: 'om_other_root', text: '大家中午吃啥' }),
    )
    assert.equal(r2, 'ignored')
  } finally {
    store.close()
  }
})

test('#接入：把当前话题接到一个正在跑的窗口上（不启动、不恢复）', async () => {
  const store = openStore(':memory:')
  try {
    const env = openEnv()
    // 执行器能报出「正在跑的会话」
    env.ports.executors.set('executor-claude', {
      ...env.ports.executors.get('executor-dsh')!,
      async listLiveSessions() {
        return [
          { sessionId: 'c510e321-full-uuid', cwd: 'E:\\Develop_E\\tt\\tt-design-space-ai', title: '会话执行链路按专家插件化分流', lastActive: Date.now() - 60_000, userTurns: 12, running: true },
        ]
      },
    })
    const projects2 = { workspaces: [] } as never
    const config = cfg({
      sessions: { newTopicPolicy: 'open' },
      executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\Develop_E'] } },
    } as never)
    const outbox = new Outbox(store, createDeliver({ ports: env.ports, config, projects: projects2, store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects2,
      rules: { rules: [] } as never,
      ports: env.ports,
      sessions: store,
      log: silent,
    })

    // 在一个没有绑定的新话题里发 #接入
    await pipeline.ingest(ev({ externalId: 'om_attach', threadId: 'omt_attach', text: '#接入' }))
    await outbox.tick()
    const card = env.actions.find((a) => a.kind === 'card_send')
    const items = card?.kind === 'card_send' ? (card.card as { items?: { sessionId: string; label: string }[] }).items : undefined
    assert.equal(items?.[0]?.sessionId, 'c510e321-full-uuid')
    assert.match(items?.[0]?.label ?? '', /会话执行链路/)

    // 点它：只绑话题，不起任何进程
    const before = env.started.length
    await pipeline.ingest(
      ev({
        externalId: 'evt_attach_1',
        source: 'source-feishu-card',
        threadId: undefined,
        raw: { type: 'card.action.trigger', event_id: 'evt_attach_1', chat_id: 'oc_1' },
        text: JSON.stringify({ k: 'attach', sid: 'c510e321-full-uuid', cwd: 'E:\\Develop_E\\tt\\tt-design-space-ai', thread: 'omt_attach', root: 'om_x_root' }),
      }),
    )
    await outbox.tick()
    assert.equal(env.started.length, before, '接入不该启动新窗口')
    const bound = routeToSession(store, 'oc_1', 'omt_attach')
    assert.equal(bound?.sessionId, 'c510e321-full-uuid', '话题要绑到这个正在跑的会话上')
    assert.match(env.sentTexts.join('\n'), /已接上正在跑的窗口/)

    // 再点另一个会话：同一个话题只留一个绑定，要改绑到新的那个
    await pipeline.ingest(
      ev({
        externalId: 'evt_attach_2',
        source: 'source-feishu-card',
        threadId: undefined,
        raw: { type: 'card.action.trigger', event_id: 'evt_attach_2', chat_id: 'oc_1' },
        text: JSON.stringify({ k: 'attach', sid: 'f08a0a77-other', cwd: 'E:\\Develop_E\\tt\\tt-design-space-ai', thread: 'omt_attach', root: 'om_x_root' }),
      }),
    )
    await outbox.tick()
    assert.equal(routeToSession(store, 'oc_1', 'omt_attach')?.sessionId, 'f08a0a77-other', '再接入要改绑到新的那个')
  } finally {
    store.close()
  }
})
