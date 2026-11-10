import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Channel, Executor } from '../../../src/domain/ports.ts'
import type { Event, Session, Work } from '../../../src/domain/types.ts'
import type { Config, Projects, Workspace } from '../../../src/kernel/config.ts'
import { eventId } from '../../../src/kernel/ids.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createDeliver, Pipeline } from '../../../src/kernel/pipeline.ts'
import { isPresent, presencePath, readPresence } from '../../../src/kernel/presence.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'
import { HELP_TEXT, parseCommand } from '../../../src/routing/commands.ts'

const silent = (): void => {}
const RULES: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }

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
function session(over: Partial<Session> = {}): Session {
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
    ...over,
  }
}
function ev(text: string, seq = ''): Event {
  const ext = `om_${text}${seq}`
  return {
    id: eventId('source-feishu-im', ext),
    source: 'source-feishu-im',
    externalId: ext,
    receivedAt: '2026-11-03T10:01:00.000Z',
    occurredAt: '2026-11-03T10:01:00.000Z',
    actor: { id: 'ou_1' },
    channel: { kind: 'group', id: 'oc_1' },
    threadId: 'om_root',
    text,
    raw: {},
  }
}

test('命令解析：只认第一行的固定词，其它当普通消息', () => {
  assert.deepEqual(parseCommand('#stop'), { kind: 'stop' })
  assert.deepEqual(parseCommand('#STOP'), { kind: 'stop' })
  assert.deepEqual(parseCommand('#unpin\n后面还有字'), { kind: 'unpin' })
  assert.deepEqual(parseCommand('#帮助'), { kind: 'help' })
  assert.equal(parseCommand('把按钮加上 #stop'), null, '不是第一行开头就不算命令')
  assert.equal(parseCommand('#乱写的'), null, '认不出就不猜')
  assert.match(HELP_TEXT, /#stop/)
})

function env() {
  const started: Work[] = []
  const stopped: string[] = []
  const pinned: { id: string; pin: boolean }[] = []
  const sent: string[] = []
  const channel: Channel = {
    async send(a) {
      if (a.kind === 'reply_only') sent.push(a.text)
      return { status: 'sent', messageId: 'om_card' }
    },
    async sendCard() {
      return { status: 'sent', messageId: 'om_card' }
    },
    async patchCard() {},
    async pinMessage(id, pin) {
      pinned.push({ id, pin })
    },
  }
  const executor: Executor = {
    async start(w: Work) {
      started.push(w)
      return { executor: 'claude', sessionId: `exec-${started.length}`, workspace: w.workspace }
    },
    async read() {
      return []
    },
    async stop(h) {
      stopped.push(h.sessionId)
    },
    async post() {},
  }
  const ports: Ports = {
    sources: new Map(),
    classifiers: new Map(),
    executors: new Map([['executor-claude', executor]]),
    channels: new Map([['channel-feishu', channel]]),
  }
  return { ports, started, stopped, pinned, sent }
}

test('#stop 停窗口并置 stopped，不再投递', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports: e.ports,
      sessions: store,
      log: silent,
    })
    assert.equal(await pipeline.ingest(ev('#stop')), 'queued')
    await outbox.tick()
    assert.deepEqual(e.stopped, ['exec-1'])
    assert.equal(store.getSession('sess-1')?.status, 'stopped')
    assert.ok(e.sent.some((t) => t.includes('已停止')))
  } finally {
    store.close()
  }
})

test('#pin / #unpin 作用在状态卡上；没有卡就明确失败', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports: e.ports,
      sessions: store,
      log: silent,
    })
    // 没有卡：应当失败重试，而不是假装置顶成功
    await pipeline.ingest(ev('#pin'))
    assert.deepEqual(await outbox.tick(), { done: 0, failed: 1, dead: 0 })

    store.upsertCard('sess-1', 'oc_1', 'om_card', 'sig')
    await pipeline.ingest(ev('#unpin'))
    await outbox.tick()
    // 那次失败的 #pin 也在重试里成功了：先置顶、再取消，顺序说明重试确实补上了
    assert.deepEqual(e.pinned, [
      { id: 'om_card', pin: true },
      { id: 'om_card', pin: false },
    ])
  } finally {
    store.close()
  }
})

test('#status 与 #help 都是回一句话，不打扰窗口', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports: e.ports,
      sessions: store,
      log: silent,
    })
    await pipeline.ingest(ev('#status'))
    await pipeline.ingest(ev('#help'))
    await outbox.tick()
    assert.ok(e.sent.some((t) => t.includes('窗口：修订单分页')))
    assert.ok(e.sent.some((t) => t.includes('#stop')))
    assert.equal(store.countOutbox('pending'), 0)
  } finally {
    store.close()
  }
})

test('在场探测：没有采样就当作不在；采样新鲜且空闲短才算在', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-presence-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  assert.equal(readPresence(root), null)
  assert.equal(isPresent(root), false, '读不到就当不在 → 照常推卡片')

  const write = (p: { idleMs: number; locked: boolean; at: string }) =>
    writeFileSync(presencePath(root), JSON.stringify(p), 'utf8')

  write({ idleMs: 1000, locked: false, at: new Date().toISOString() })
  assert.equal(isPresent(root), true)

  write({ idleMs: 1000, locked: true, at: new Date().toISOString() })
  assert.equal(isPresent(root), false, '锁屏就算不在')

  write({ idleMs: 10 * 60_000, locked: false, at: new Date().toISOString() })
  assert.equal(isPresent(root), false, '空闲太久算不在')

  write({ idleMs: 1000, locked: false, at: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(readPresence(root), null, '采样过期不能当现状')
})

test('置顶账：只撤自己置的；停窗口顺手撤', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports: e.ports,
      sessions: store,
      log: silent,
    })
    store.upsertCard('sess-1', 'oc_1', 'om_card', 'sig')

    // 从没置顶过：取消置顶应当什么都不做（否则会撤掉别人置的）
    await pipeline.ingest(ev('#unpin', '-1'))
    await outbox.tick()
    assert.deepEqual(e.pinned, [])

    // 自己置顶 → 记账 → 再取消才有动作
    await pipeline.ingest(ev('#pin', '-2'))
    await outbox.tick()
    assert.equal(store.isCardPinned('sess-1'), true)
    await pipeline.ingest(ev('#unpin', '-3'))
    await outbox.tick()
    assert.equal(store.isCardPinned('sess-1'), false)
    assert.deepEqual(e.pinned, [
      { id: 'om_card', pin: true },
      { id: 'om_card', pin: false },
    ])

    // 停窗口时如果还置顶着，顺手撤
    await pipeline.ingest(ev('#pin', '-4'))
    await outbox.tick()
    await pipeline.ingest(ev('#stop', '-5'))
    await outbox.tick()
    assert.deepEqual(e.pinned.at(-1), { id: 'om_card', pin: false })
    assert.equal(store.isCardPinned('sess-1'), false)
  } finally {
    store.close()
  }
})

test('回执冷却：同一类回执在冷却窗口内只回一次，换一类照回', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const config = { ...cfg(), sessions: { newTopicPolicy: 'judge', choiceTtlMs: 60_000, replyCooldownMs: 10_000 } } as Config
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: RULES,
      ports: e.ports,
      sessions: store,
      log: silent,
    })

    await pipeline.ingest(ev('#status', '-a'))
    await outbox.tick()
    const first = e.sent.length
    assert.equal(first, 1)

    await pipeline.ingest(ev('#status', '-b'))
    await outbox.tick()
    assert.equal(e.sent.length, first, '冷却内同一类回执不重复')

    await pipeline.ingest(ev('#help', '-c'))
    await outbox.tick()
    assert.equal(e.sent.length, first + 1, '换一类回执照回')

    // 冷却落库：换个「进程」（同一库）也还认得
    assert.equal(store.allowReply('sess-1', 'status-reply', 10_000), false)
    assert.equal(store.allowReply('sess-1', 'status-reply', 10_000, Date.now() + 11_000), true)
  } finally {
    store.close()
  }
})

test('#resume / #new：恢复与换窗口，已停的窗口先回一句再谈', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session({ status: 'stopped' }))
    const e = env()
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports: e.ports,
      sessions: store,
      log: silent,
    })

    // 已停的窗口收到普通消息：回一句提示，不投递
    assert.equal(await pipeline.ingest(ev('再改一版', '-s1')), 'queued')
    await outbox.tick()
    assert.ok(e.sent.some((t) => t.includes('已经停了')))

    // #resume：列同工作区的历史会话让你挑（不再直接改状态——没有活着的执行器，
    // 硬置回 active 只会让下一条消息投递失败）
    await pipeline.ingest(ev('#resume', '-s2'))
    await outbox.tick()
    assert.equal(store.getSession('sess-1')?.status, 'stopped', '没挑定会话前不改状态')

    // #new 关掉，下一条消息才算新任务
    await pipeline.ingest(ev('#new', '-s3'))
    await outbox.tick()
    assert.equal(store.getSession('sess-1')?.status, 'stopped')
    assert.ok(e.sent.some((t) => t.includes('已关闭')))
  } finally {
    store.close()
  }
})

test('状态卡：按间隔把执行器最新一行进度刷上去', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    store.upsertCard('sess-1', 'oc_1', 'om_card_old', 'sig-old')
    let reads = 0
    const executor: Executor = {
      async start() {
        return { executor: 'claude', sessionId: 'x', workspace: 'w' }
      },
      async read() {
        reads++
        return [{ at: new Date().toISOString(), kind: 'output', text: '第一行\n正在改分页组件' }]
      },
      async stop() {},
      async post() {},
    }
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
      async sendCard() {
        return { status: 'sent', messageId: 'om_card' }
      },
      async patchCard() {},
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const config = { ...cfg(), sessions: { newTopicPolicy: 'judge', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 1 } } as Config
    const outbox = new Outbox(store, createDeliver({ ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: RULES,
      ports,
      sessions: store,
      log: silent,
    })

    assert.equal(await pipeline.refreshCards(), 1, '应有 1 张卡被刷新')
    assert.equal(reads, 1)
    const action = store.listOutbox('pending')[0]?.action
    assert.equal(action?.kind, 'card_upsert')
    if (action?.kind === 'card_upsert') {
      assert.ok(action.card.lines.some((l) => l.includes('正在改分页组件')), '卡上要显示最新一行')
    }
  } finally {
    store.close()
  }
})

test('状态卡：读不到新进度就不动卡（别把空内容刷上去）', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    store.upsertCard('sess-1', 'oc_1', 'om_card_old', 'sig-old')
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
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
      async sendCard() {
        return { status: 'sent', messageId: 'om_card' }
      },
      async patchCard() {},
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const config = { ...cfg(), sessions: { newTopicPolicy: 'judge', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 1 } } as Config
    const outbox = new Outbox(store, createDeliver({ ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: RULES,
      ports,
      sessions: store,
      log: silent,
    })
    assert.equal(await pipeline.refreshCards(), 0)
    assert.equal(store.listOutbox('pending').length, 0, '没有新内容就不该入队')
  } finally {
    store.close()
  }
})

test('提醒会 @ 发起人；没有发起人 id 就不编', async () => {
  const { formatNotifyText } = await import('../../../src/kernel/hook-handlers.ts')
  const s1 = session({ ownerId: 'ou_abc' })
  assert.match(formatNotifyText(s1, { message: '要你确认' }), /^<at user_id="ou_abc"><\/at> /)
  const s2 = session({ ownerId: undefined })
  assert.ok(!formatNotifyText(s2, { message: '要你确认' }).includes('<at '), '没 id 就不能编 @')
  assert.match(formatNotifyText(s1, { message: '要你确认' }, false), /^⚠️ /)
})

test('置顶对账：刚置上不到 5 分钟的先不撤（撤了下一秒又要置上）', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session({ id: 'sess-dead', threadId: 'om_b', status: 'stopped' }))
    store.upsertCard('sess-dead', 'oc_1', 'om_card_dead', 'sig')
    store.setCardPinned('sess-dead', true) // 就是刚刚

    const pinned: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
      async pinMessage(id) {
        pinned.push(id)
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
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
    assert.equal(await pipeline.reconcilePins(), 0, '刚置上的先别动')
    assert.deepEqual(pinned, [])
  } finally {
    store.close()
  }
})

test('置顶对账：已停会话的置顶被撤掉，活跃的不动', async () => {
  const store = openStore(':memory:')
  try {
    // 活跃 = 刚刚动过：新规则下「active 但很久没动静」会被当成关窗
    store.insertSession(session({ id: 'sess-live', threadId: 'om_a', lastActiveAt: new Date().toISOString() }))
    store.insertSession(session({ id: 'sess-dead', threadId: 'om_b', status: 'stopped' }))
    store.upsertCard('sess-live', 'oc_1', 'om_card_live', 'sig')
    store.upsertCard('sess-dead', 'oc_1', 'om_card_dead', 'sig')
    // 置上一小时了（5 分钟内的先不撤）
    const anHourAgo = new Date(Date.now() - 3_600_000)
    store.setCardPinned('sess-live', true, anHourAgo)
    store.setCardPinned('sess-dead', true, anHourAgo)

    const pinned: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
      async pinMessage(id) {
        pinned.push(id)
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map([['channel-feishu', channel]]),
    }
    const pipeline = new Pipeline({
      store,
      outbox: new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent })),
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports,
      sessions: store,
      log: silent,
    })
    assert.equal(await pipeline.reconcilePins(), 1)
    assert.deepEqual(pinned, ['om_card_dead'])
    assert.equal(store.isCardPinned('sess-live'), true, '活跃会话的置顶不该被动')
  } finally {
    store.close()
  }
})

test('状态卡不换消息：转录里出现新的一轮 → 还是那一条卡原地更新', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const store = openStore(':memory:')
  try {
    store.insertSession(session({ id: 'sess-1', sessionId: 'sid-x' }))
    store.upsertCard('sess-1', 'oc_1', 'om_card_old', 'sig-old')
    store.setCardTurn('sess-1', 'u1')

    const dir = mkdtempSync(join(tmpdir(), 'lingcub-turn-'))
    const f = join(dir, 'sid-x.jsonl')
    const userLine = (uuid: string, text: string): string =>
      JSON.stringify({ type: 'user', uuid, timestamp: new Date().toISOString(), message: { content: text } }) + '\n'
    writeFileSync(f, userLine('u1', '第一轮') + userLine('u2', '第二轮') + '\n')

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
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
      async sendCard() {
        return { status: 'sent', messageId: 'om_card' }
      },
      async patchCard() {},
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const config = {
      ...cfg(),
      sessions: { newTopicPolicy: 'judge', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 1 },
    } as Config
    const outbox = new Outbox(store, createDeliver({ ports, config, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store,
      outbox,
      config,
      projects: projects(),
      rules: RULES,
      ports,
      sessions: store,
      log: silent,
      transcripts: () => f,
    })

    await pipeline.refreshCards()
    // 同一个窗口永远只用一条消息：换了新一轮也是原地改它，
    // 因为只有话题根那条在群主消息流的「Pin 消息」面板里可见。
    assert.equal(store.getCard('sess-1')?.messageId, 'om_card_old', '还是原来那张卡')
    assert.equal(store.cardTurn('sess-1'), 'u2', '轮次要跟上，否则每拍都重画')
    const patches = store.listOutbox('pending').filter((r) => r.action.kind === 'card_patch')
    assert.equal(patches.length, 0, '不换卡就不用把旧卡改灰')
  } finally {
    store.close()
  }
})

test('#新窗：另起一棵新话题开窗口，本话题的绑定不动', async () => {
  const store = openStore(':memory:')
  try {
    const e = env()
    store.insertSession(session({ id: 'sess-cur', threadId: 'om_root', workspace: 'personal-lingcub' }))
    const outbox = new Outbox(
      store,
      createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }),
    )
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: RULES,
      ports: e.ports,
      sessions: store,
      log: silent,
    })

    await pipeline.ingest(ev('#新窗'))
    await outbox.tick()
    // 本话题已经绑了窗口，`#新窗` 是「再开一个」：不能把消息投给现有窗口
    assert.deepEqual(e.stopped, [], '不该去停现有窗口')
    assert.equal(store.getSession('sess-cur')?.threadId, 'om_root', '本话题原来的绑定不能被改掉')

    // 回序号选中：应为「另起一棵新话题」——不带话题、不回进本话题
    const pending = store.getChoice('om_root', 'workspace') as { fresh?: boolean } | null
    assert.equal(pending?.fresh, true, '待选表要标成 fresh，否则会绑回本话题')

    // 回序号选中：必须另起一棵新话题（不带 threadId、锚消息不回进本话题）
    await pipeline.ingest(ev('1', '-pick'))
    await outbox.tick()
    const work = e.started.at(-1)
    assert.ok(work, '要起一个新窗口')
    assert.equal(work?.origin?.threadId, undefined, '新窗口不能绑回本话题')
    assert.equal(work?.origin?.rootMessageId, '', '锚消息不回进本话题，自成新话题')
    assert.equal(store.getSession('sess-cur')?.threadId, 'om_root', '本话题的绑定依然不动')
  } finally {
    store.close()
  }
})

test('工作区候选上限可配（pickMax），按最近活跃截断', async () => {
  const store = openStore(':memory:')
  try {
    const e = env()
    const many = { workspaces: [ws(), ...Array.from({ length: 6 }, (_, i) => ({ ...ws(), id: `w${i}`, name: `工作区${i}`, root: `E:\\w${i}`, aliases: [] }))] }
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: many, store, log: silent }))
    const config = { ...cfg(), sessions: { ...cfg().sessions, newTopicPolicy: 'open', pickMax: 3 } } as Config
    const pipeline = new Pipeline({ store, outbox, config, projects: many, rules: RULES, ports: e.ports, sessions: store, log: silent })
    await pipeline.ingest(ev('开个窗'))
    await outbox.tick()
    const pending = store.getChoice('om_root', 'workspace') as { options: unknown[] } | null
    assert.equal(pending?.options.length, 3, 'pickMax=3 时只列 3 个')
  } finally {
    store.close()
  }
})

test('命令前缀匹配：#resume 带参数也认，#继续 也算恢复', async () => {
  const { parseCommand } = await import('../../../src/routing/commands.ts')
  assert.deepEqual(parseCommand('#resume'), { kind: 'resume' })
  // 带参数：以前会被当成正文投进窗口，用户以为命令生效了
  assert.deepEqual(parseCommand('#resume 一下'), { kind: 'resume' })
  assert.deepEqual(parseCommand('#继续'), { kind: 'resume' })
  assert.deepEqual(parseCommand('#恢复 上次那个'), { kind: 'resume' })
  // 不是命令的别误判
  assert.equal(parseCommand('#我的任务 描述'), null)
  assert.equal(parseCommand('普通消息 #resume'), null)
})

test('#绝对路径 单发：认出盘符/绝对路径，别的一概不算', async () => {
  const { parseAbsolutePathCommand } = await import('../../../src/routing/commands.ts')
  assert.equal(parseAbsolutePathCommand('#E:\\Develop_E\\lingcub'), 'E:\\Develop_E\\lingcub')
  assert.equal(parseAbsolutePathCommand('#/home/yue/proj'), '/home/yue/proj')
  assert.equal(parseAbsolutePathCommand('#lingcub'), null, '没有盘符/斜杠就不是路径')
  assert.equal(parseAbsolutePathCommand('#resume'), null)
  assert.equal(parseAbsolutePathCommand('E:\\x'), null, '不带 # 的普通消息不算')
})

async function pinEnv(
  lastActiveAt: string,
  status: 'active' | 'stopped' = 'active',
  executor: 'claude' | 'dsh' = 'claude',
) {
  const store = openStore(':memory:')
  store.insertSession(session({ id: 'sess-stale', threadId: 'om_b', status, lastActiveAt, executor }))
  store.upsertCard('sess-stale', 'oc_1', 'om_card_stale', 'sig')
  // 置顶时间回拨 10 分钟，越过「5 分钟内新置不撤」的护栏，才测得到 stale 规则
  store.setCardPinned('sess-stale', true, new Date(Date.now() - 10 * 60_000))
  const pinned: string[] = []
  const channel: Channel = {
    async send() {
      return { status: 'sent' }
    },
    async pinMessage(id) {
      pinned.push(id)
    },
  }
  const ports: Ports = {
    sources: new Map(),
    classifiers: new Map(),
    executors: new Map(),
    channels: new Map([['channel-feishu', channel]]),
  }
  const config = cfg()
  const projects = { workspaces: [ws()] }
  const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }))
  const pipeline = new Pipeline({ store, outbox, config, projects, rules: RULES, ports, sessions: store, log: silent })
  return { store, pinned, pipeline }
}

test('置顶对账：dsh 会话不按「多久没说话」撤置顶（没有关窗信号就不猜）', async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString()
  const s = await pinEnv(twoHoursAgo, 'active', 'dsh')
  try {
    assert.equal(await s.pipeline.reconcilePins(), 0, 'dsh 两小时没说话也还是「开着」')
    assert.deepEqual(s.pinned, [], '不能撤')
    assert.equal(s.store.isCardPinned('sess-stale'), true, '标记也不能被清掉')
  } finally {
    s.store.close()
  }
})

test('置顶对账：claude 窗口开着就保留置顶，八小时没发言也不撤', async () => {
  // 2026-11-09 的真实故障：窗口开着、人只是在看代码，30 分钟没说话就被当成「已停会话」撤了置顶
  const eightHoursAgo = new Date(Date.now() - 8 * 3600_000).toISOString()
  const s = await pinEnv(eightHoursAgo, 'active', 'claude')
  try {
    assert.equal(await s.pipeline.reconcilePins(), 0, 'claude 的「还在不在」由关窗回收判定，不按说话时间')
    assert.deepEqual(s.pinned, [], '不能撤')
    assert.equal(s.store.isCardPinned('sess-stale'), true, '标记也不能被清掉')
  } finally {
    s.store.close()
  }
})

test('置顶对账：活跃会话（10 分钟内动过）不动它的置顶', async () => {
  const fresh = new Date(Date.now() - 60_000).toISOString()
  const s = await pinEnv(fresh)
  try {
    const pinned = s.pinned
    assert.equal(await s.pipeline.reconcilePins(), 0, '活跃窗口不撤置顶')
    assert.deepEqual(pinned, [])
  } finally {
    s.store.close()
  }
})
test('关窗回收：执行器说它不在跑、且过了保护期 → 标 dead 并撤置顶', async () => {
  const store = openStore(':memory:')
  try {
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    store.insertSession(session({ id: 'sess-closed', threadId: 'om_b', sessionId: 'c510e321', lastActiveAt: old }))
    store.upsertCard('sess-closed', 'oc_1', 'om_card_closed', 'sig')
    store.setCardPinned('sess-closed', true, new Date(Date.now() - 10 * 60_000))

    const pinned: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
      async pinMessage(id) {
        pinned.push(id)
      },
    }
    const executor = {
      async start() {
        throw new Error('不该被调用')
      },
      async read() {
        return []
      },
      async stop() {},
      async listLiveSessions() {
        return [] // 一个在跑的都没有：窗口关了
      },
    } as unknown as Executor
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const config = cfg()
    const projects = { workspaces: [ws()] }
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }))
    const pipeline = new Pipeline({ store, outbox, config, projects, rules: RULES, ports, sessions: store, log: silent })

    assert.equal(await pipeline.reapDeadSessions(), 1)
    assert.equal(store.getSession('sess-closed')?.status, 'dead')
    assert.equal(await pipeline.reconcilePins(), 1, 'dead 之后置顶要被撤')
  } finally {
    store.close()
  }
})

test('关窗回收：执行器仍在列（全 uuid vs 短 id）就不动；刚活动过的也放过', async () => {
  const store = openStore(':memory:')
  try {
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    store.insertSession(session({ id: 'sess-live', threadId: 'om_a', sessionId: 'c510e321', lastActiveAt: old }))
    store.insertSession(
      session({ id: 'sess-fresh', threadId: 'om_c', sessionId: 'ffffffff', lastActiveAt: new Date().toISOString() }),
    )
    const executor = {
      async start() {
        throw new Error('不该被调用')
      },
      async read() {
        return []
      },
      async stop() {},
      async listLiveSessions() {
        return [{ sessionId: 'c510e321-4f0a-402a-a796-402bd5e25264', cwd: 'E:\\x', title: 't', lastActive: 0, userTurns: 0, running: true }]
      },
    } as unknown as Executor
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map(),
    }
    const config = cfg()
    const projects = { workspaces: [ws()] }
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }))
    const pipeline = new Pipeline({ store, outbox, config, projects, rules: RULES, ports, sessions: store, log: silent })
    assert.equal(await pipeline.reapDeadSessions(), 0)
    assert.equal(store.getSession('sess-live')?.status, 'active', '前缀匹配到活会话就不能标死')
    assert.equal(store.getSession('sess-fresh')?.status, 'active', '保护期内不动')
  } finally {
    store.close()
  }
})
test('置顶记账：频道发卡默认置顶时，核心里要记下「这张卡已置顶」', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session({ id: 'sess-pin', threadId: 'om_p', lastActiveAt: new Date().toISOString() }))
    const pinned: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
      async sendCard() {
        return { status: 'sent', messageId: 'om_card_pin' }
      },
      async pinMessage(id: string) {
        pinned.push(id)
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map(),
      channels: new Map([['channel-feishu', channel]]),
    }
    const config = cfg()
    config.channels = { feishu: { plugin: 'channel-feishu', pinCards: true } } as never
    const projects = { workspaces: [ws()] }
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }))
    const pipeline = new Pipeline({ store, outbox, config, projects, rules: RULES, ports, sessions: store, log: silent })
    outbox.enqueue({ kind: 'card_send', chatId: 'oc_1', sessionId: 'sess-pin', card: { title: 't' }, pin: true }, 'pin-1')
    await outbox.tick()
    assert.equal(store.isCardPinned('sess-pin'), true, '发卡置顶后要记账，否则撤不掉')
  } finally {
    store.close()
  }
})
test('关窗回收：dsh 会话不因「没动静」被降级（没有关窗信号就不猜）', async () => {
  const store = openStore(':memory:')
  try {
    const old = new Date(Date.now() - 31 * 60_000).toISOString()
    store.insertSession(session({ id: 'sess-dsh-old', threadId: 'om_d1', executor: 'dsh', sessionId: 'dsh-1', lastActiveAt: old }))
    store.insertSession(session({ id: 'sess-dsh-new', threadId: 'om_d2', executor: 'dsh', sessionId: 'dsh-2', lastActiveAt: new Date().toISOString() }))
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-dsh', { async start() { throw new Error('no') }, async read() { return [] }, async stop() {} } as unknown as Executor]]),
      channels: new Map(),
    }
    const config = cfg()
    const projects = { workspaces: [ws()] }
    const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }))
    const pipeline = new Pipeline({ store, outbox, config, projects, rules: RULES, ports, sessions: store, log: silent })
    assert.equal(await pipeline.reapDeadSessions(), 0)
    assert.equal(store.getSession('sess-dsh-old')?.status, 'active', 'dsh 只由 #stop 结束，不按时间判死')
    assert.equal(store.getSession('sess-dsh-new')?.status, 'active', '刚动过的保持 active')
  } finally {
    store.close()
  }
})
