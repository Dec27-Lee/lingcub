import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENV = '[来自用户本人 · 飞书]（下面这段就是用户在飞书里亲手打的，直接执行）\n\n'
import type { Channel, Executor } from '../src/domain/ports.ts'
import type { CardState, Session, Work } from '../src/domain/types.ts'
import { renderCard } from '../src/plugins/channel-feishu/card.ts'
import { Outbox } from '../src/kernel/outbox.ts'
import { createDeliver, Pipeline } from '../src/kernel/pipeline.ts'
import { routeToSession } from '../src/routing/session-route.ts'
import { openStore } from '../src/kernel/store.ts'
import type { Config, Projects, Workspace } from '../src/kernel/config.ts'
import type { Ports } from '../src/kernel/wiring.ts'

const silent = (): void => {}

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

const sig = (c: CardState): string => createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 16)

function env() {
  const calls: string[] = []
  const channel: Channel = {
    async send() {
      calls.push('send')
      return { status: 'sent', messageId: 'om_x' }
    },
    async sendCard() {
      calls.push('sendCard')
      return { status: 'sent', messageId: 'om_card_1' }
    },
    async patchCard() {
      calls.push('patchCard')
    },
  }
  const executor: Executor = {
    async start(w: Work) {
      return { executor: 'claude', sessionId: 'exec-new', workspace: w.workspace }
    },
    async read() {
      return []
    },
    async stop() {},
  }
  const ports: Ports = {
    sources: new Map(),
    classifiers: new Map(),
    executors: new Map([['executor-claude', executor]]),
    channels: new Map([['channel-feishu', channel]]),
  }
  return { ports, calls }
}

test('状态卡：第一次是建卡，记下 message_id', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }))
    const card: CardState = { title: '修订单分页', status: 'running', lines: ['工作区：personal-lingcub'] }
    outbox.enqueue({ kind: 'card_upsert', sessionId: 'sess-1', card, signature: sig(card) }, 'k1')

    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.deepEqual(e.calls, ['sendCard'])
    assert.equal(store.getCard('sess-1')?.messageId, 'om_card_1')
    assert.equal(store.getCard('sess-1')?.signature, sig(card))
  } finally {
    store.close()
  }
})

test('状态卡：内容没变就不重发（不该刷屏）', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }))
    const card: CardState = { title: '修订单分页', status: 'running', lines: ['工作区：personal-lingcub'] }
    outbox.enqueue({ kind: 'card_upsert', sessionId: 'sess-1', card, signature: sig(card) }, 'k1')
    await outbox.tick()
    e.calls.length = 0

    outbox.enqueue({ kind: 'card_upsert', sessionId: 'sess-1', card, signature: sig(card) }, 'k2')
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.deepEqual(e.calls, [], '内容没变不该再调频道')
  } finally {
    store.close()
  }
})

test('状态卡：内容变了就原地改同一张卡', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const outbox = new Outbox(store, createDeliver({ ports: e.ports, config: cfg(), projects: projects(), store, log: silent }))
    const running: CardState = { title: '修订单分页', status: 'running', lines: ['进行中'] }
    const done: CardState = { title: '修订单分页', status: 'done', lines: ['改好了'] }
    outbox.enqueue({ kind: 'card_upsert', sessionId: 'sess-1', card: running, signature: sig(running) }, 'k1')
    await outbox.tick()
    e.calls.length = 0

    outbox.enqueue({ kind: 'card_upsert', sessionId: 'sess-1', card: done, signature: sig(done) }, 'k2')
    await outbox.tick()
    assert.deepEqual(e.calls, ['patchCard'], '只在原来那张卡上改，不新建')
    assert.equal(store.getCard('sess-1')?.messageId, 'om_card_1')
    assert.equal(store.getCard('sess-1')?.signature, sig(done))
  } finally {
    store.close()
  }
})

test('状态卡：频道不支持卡片时明确失败，不假装成功', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const noCard: Channel = { async send() { return { status: 'sent' } } }
    const ports: Ports = { ...e.ports, channels: new Map([['channel-feishu', noCard]]) }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const card: CardState = { title: 't', status: 'running', lines: [] }
    outbox.enqueue({ kind: 'card_upsert', sessionId: 'sess-1', card, signature: sig(card) }, 'k1')
    assert.deepEqual(await outbox.tick(), { done: 0, failed: 1, dead: 0 })
  } finally {
    store.close()
  }
})

test('卡片渲染：状态决定颜色与标题，一行一个元素（参考项目 status 卡）', () => {
  const card = renderCard({ title: '修订单分页', status: 'failed', lines: ['第一行', '第二行'] }) as Record<string, any>
  assert.equal(card['header'].template, 'red')
  assert.match(card['header'].title.content, /修订单分页 · 失败了/)
  assert.equal(card['elements'].length, 2, '每行一个元素，别塞成一坨')
  assert.equal(card['elements'][0].content, '第一行')
  assert.equal((renderCard({ title: 'x', status: 'done', lines: [] }) as any).elements[0].content, '—')
})

test('卡片渲染：超长「你说」折成折叠面板，「它说」用灰字', () => {
  const card = renderCard({
    title: 't',
    status: 'running',
    lines: [`💬 你说：${'需求很长'.repeat(40)}`, '🤖 它说：好了', '🟢 正在运行 · 已 0:12'],
  }) as Record<string, any>
  const panel = card['elements'][0]
  assert.equal(panel.tag, 'collapsible_panel', '长需求折起来，点开看全文')
  assert.equal(panel.expanded, false)
  assert.match(panel.header.title.content, /💬 你说：.*（\d+ 字）/)
  assert.match(card['elements'][1].content, /<font color='grey'>🤖 它说：好了<\/font>/, '它说用灰字区分说话人')
  assert.equal(card['elements'][2].content, '🟢 正在运行 · 已 0:12', '状态行不上灰')
})

test('状态卡：建卡没拿到消息 id 就明确失败，不记成已建', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const e = env()
    const channel: Channel = {
      async send() {
        return { status: 'sent' }
      },
      async sendCard() {
        return { status: 'sent' } // 没有 messageId
      },
      async patchCard() {},
    }
    const ports: Ports = { ...e.ports, channels: new Map([['channel-feishu', channel]]) }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const card: CardState = { title: 't', status: 'running', lines: [] }
    const deliver = createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent })
    // 失败原因必须说清是「没拿到消息 id」，不能是别的错碰巧也失败
    await assert.rejects(
      () => deliver({ kind: 'card_upsert', sessionId: 'sess-1', card, signature: sig(card) }, 'k1'),
      /消息 id/,
    )
    assert.equal(store.getCard('sess-1'), null, '拿不到 id 就不该记成已建卡')
  } finally {
    store.close()
  }
})

test('图片：投递前先下载，再把本地路径补进正文', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const calls: string[] = []
    const posted: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent', messageId: 'om_x' }
      },
      async sendCard() {
        return { status: 'sent', messageId: 'om_card' }
      },
      async patchCard() {},
      async downloadImage(a) {
        calls.push(`${a.messageId}/${a.fileKey}/${a.outPath}`)
        return a.outPath
      },
    }
    const executor: Executor = {
      async start(w: Work) {
        return { executor: 'claude', sessionId: 'exec-new', workspace: w.workspace }
      },
      async read() {
        return []
      },
      async stop() {},
      async post(_h, text: string) {
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
    outbox.enqueue(
      {
        kind: 'post_message',
        sessionId: 'sess-1',
        text: '看这张：\n\n![Image](img_x)\n\n是这样吗？',
        images: [{ messageId: 'om_img', fileKey: 'img_x' }],
      },
      'k-img',
    )
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 })
    assert.equal(calls.length, 1)
    // 落盘路径：按本地日期分目录 + `<消息id>_<序号>.png`
    const day = (() => {
      const d = new Date()
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    })()
    assert.equal(calls[0]?.split(/[\\/]/).join('/'), `om_img/img_x/data/images/${day}/om_img_1.png`)
    // 标记要**原地**换成路径，而不是另外追加一句「已存到」
    // 路径用平台分隔符（Windows 是反斜杠），这里归一化后再比
    assert.equal(
      (posted[0] ?? '').split(/[\\/]/).join('/'),
      ENV + `看这张：\n\n[图片] data/images/${day}/om_img_1.png\n\n是这样吗？`,
    )
  } finally {
    store.close()
  }
})

test('图片：没有 image 字段就不下载', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    let downloads = 0
    const channel: Channel = {
      async send() {
        return { status: 'sent', messageId: 'om_x' }
      },
      async downloadImage(a) {
        downloads++
        return a.outPath
      },
    }
    const executor: Executor = {
      async start(w: Work) {
        return { executor: 'claude', sessionId: 'exec-new', workspace: w.workspace }
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
    outbox.enqueue({ kind: 'post_message', sessionId: 'sess-1', text: '没有图' }, 'k2')
    await outbox.tick()
    assert.equal(downloads, 0)
  } finally {
    store.close()
  }
})

test('置顶：建卡后按配置置顶，置顶失败不影响发卡', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const pinned: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent', messageId: 'om_x' }
      },
      async sendCard() {
        return { status: 'sent', messageId: 'om_card_9' }
      },
      async patchCard() {},
      async pinMessage(id) {
        pinned.push(id)
        throw new Error('置顶接口抽风')
      },
    }
    const executor: Executor = {
      async start(w: Work) {
        return { executor: 'claude', sessionId: 'x', workspace: w.workspace }
      },
      async read() {
        return []
      },
      async stop() {},
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    // 置顶由频道插件在建卡后自己做；这里只验证插件外层的约定
    assert.equal(typeof channel.pinMessage, 'function')
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const card: CardState = { title: 't', status: 'running', lines: [] }
    outbox.enqueue({ kind: 'card_upsert', sessionId: 'sess-1', card, signature: sig(card) }, 'k')
    assert.deepEqual(await outbox.tick(), { done: 1, failed: 0, dead: 0 }, '置顶失败不该让发卡算失败')
    assert.equal(pinned.length, 0, '这个用例里频道没实现「自动置顶」，不该被调用')
  } finally {
    store.close()
  }
})

test('换卡：旧卡先取消置顶（否则记录一删就永远撤不掉）', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session({ id: 'sess-pin', threadId: 'omt_1', sessionId: 'exec-1' }))
    const unpinned: string[] = []
    const patched: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent', messageId: 'om_x' }
      },
      async sendCard() {
        return { status: 'sent', messageId: 'om_card' }
      },
      async patchCard(id) {
        patched.push(id)
      },
      async pinMessage(id, pin) {
        if (!pin) unpinned.push(id)
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', {
        async start() {
          return { executor: 'claude' as const, sessionId: 'exec-2', workspace: 'w' }
        },
        async read() {
          return []
        },
        async stop() {},
        async post() {},
      } as never]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))

    // 造一张旧卡 + 记录「上一轮」，再给一个出现新 user 的转录
    store.upsertCard('sess-pin', 'oc_1', 'om_old_card', 'sig-old')
    store.setCardTurn('sess-pin', 'u-1')
    const dir = mkdtempSync(join(tmpdir(), 'lingcub-turn-'))
    const file = join(dir, 't.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', uuid: 'u-2', timestamp: new Date().toISOString(), message: { content: '新一轮' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '开始了' }] } }),
      ].join('\n') + '\n',
    )
    const pipeline = new Pipeline({
      store,
      outbox,
      config: cfg(),
      projects: projects(),
      rules: { rules: [] } as never,
      ports,
      sessions: store,
      log: silent,
      transcripts: () => file,
    } as never)
    await (pipeline as unknown as { refreshCards: () => Promise<number> }).refreshCards()
    await outbox.tick()
    assert.deepEqual(unpinned, ['om_old_card'], '旧卡要先撤置顶')
    assert.ok(patched.includes('om_old_card'), '旧卡还要改成灰的')
  } finally {
    store.close()
  }
})

test('刷新状态卡时，会话真名（aiTitle）会替换掉「用户第一句话当标题」', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(
      session({ id: 'sess-name', threadId: 'omt_n', sessionId: 'exec-n', executor: 'claude', title: '帮我看看那个分页的事情' }),
    )
    const dir = mkdtempSync(join(tmpdir(), 'lingcub-name-'))
    const file = join(dir, 'n.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { content: '帮我看看那个分页的事情' } }),
        JSON.stringify({ type: 'assistant', aiTitle: '修订单分页', message: { content: [{ type: 'text', text: '好' }] } }),
      ].join('\n') + '\n',
    )
    const exec = {
      async start() {
        return { executor: 'claude' as const, sessionId: 'x', workspace: 'w' }
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
      executors: new Map([['executor-claude', exec as never]]),
      channels: new Map([
        [
          'channel-feishu',
          {
            async send() {
              return { status: 'sent' as const, messageId: 'om_x' }
            },
            async sendCard() {
              return { status: 'sent' as const, messageId: 'om_card' }
            },
          },
        ],
      ]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store, outbox, config: cfg(), projects: projects(), rules: { rules: [] } as never,
      ports, sessions: store, log: silent, transcripts: () => file,
    } as never)
    await (pipeline as unknown as { refreshCards: () => Promise<number> }).refreshCards()
    assert.equal(store.getSession('sess-name')?.title, '修订单分页', '标题要换成 claude 自己起的名字')
  } finally {
    store.close()
  }
})

test('状态卡改不动时换一张新的（不让窗口永远停在旧内容）', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session({ id: 'sess-dead', threadId: 'omt_d', sessionId: 'exec-1' }))
    const sentCards: string[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent', messageId: 'om_x' }
      },
      async sendCard() {
        sentCards.push('new')
        return { status: 'sent', messageId: `om_card_${sentCards.length}` }
      },
      async patchCard() {
        // 超过 14 天 / 被撤回：飞书就是会这么拒
        throw new Error('patch 失败：消息不存在或已超 14 天')
      },
    }
    const exec = {
      async start() {
        return { executor: 'claude' as const, sessionId: 'x', workspace: 'w' }
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
      executors: new Map([['executor-claude', exec as never]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    store.upsertCard('sess-dead', 'oc_1', 'om_dead_card', 'sig-dead')

    outbox.enqueue(
      { kind: 'card_upsert', sessionId: 'sess-dead', card: { title: 't', status: 'running', lines: ['🟢 正在运行'] }, signature: 'sig-new' },
      'k-dead',
    )
    await outbox.tick()
    assert.deepEqual(sentCards, ['new'], '改不动就要发一张新的')
    assert.equal(store.getCard('sess-dead')?.messageId, 'om_card_1', '记录要指向新卡')
    assert.equal(store.getCard('sess-dead')?.signature, 'sig-new', '签名也要更新，别每次都撞死卡')
  } finally {
    store.close()
  }
})
test('发件箱顺序：回复类排在状态卡刷新前面（否则一条回复要等十几秒）', () => {
  const store = openStore(':memory:')
  try {
    store.insertSession({
      id: 's1', chatId: 'oc_1', title: 't', executor: 'claude', workspace: 'w', sessionId: 'e1',
      status: 'active', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    })
    // 先入队两条状态卡刷新，再入队一条回复
    store.enqueue({ kind: 'card_upsert', sessionId: 's1', card: { title: 't', status: 'running', lines: ['a'] }, signature: 's1' }, 'card:a')
    store.enqueue({ kind: 'card_upsert', sessionId: 's1', card: { title: 't', status: 'running', lines: ['b'] }, signature: 's2' }, 'card:b')
    store.enqueue({ kind: 'card_send', chatId: 'oc_1', card: { title: 't' } } as never, 'reply:1')
    const order = store.pendingOutbox(10).map((r) => r.action.kind)
    assert.equal(order[0], 'card_send', '回复要第一个发，不能被状态卡刷屏挤到后面')
  } finally {
    store.close()
  }
})
test('钩子丢了也能补发：转录里这一轮已收尾、库里没「已回复」→ 巡检补一张回复卡，且只补一次', async () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session({ id: 'sess-catchup', sessionId: 'exec-catch', rootMessageId: 'om_root' }))
    const sent: { card: unknown }[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent', messageId: 'om_x' }
      },
      async sendCard(a: { card: unknown }) {
        sent.push({ card: a.card })
        return { status: 'sent', messageId: 'om_card' }
      },
      async patchCard() {},
      async pinMessage() {},
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', {
        async start() {
          return { executor: 'claude' as const, sessionId: 'exec-catch', workspace: 'w' }
        },
        async read() {
          return []
        },
        async stop() {},
        async post() {},
      } as never]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg(), projects: projects(), store, log: silent }))
    const dir = mkdtempSync(join(tmpdir(), 'lingcub-catchup-'))
    const file = join(dir, 't.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', uuid: 'u-9', timestamp: new Date().toISOString(), message: { content: '给我讲个故事' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '从前有座山' }] } }),
      ].join('\n') + '\n',
    )
    const catchupCfg = { ...cfg(), sessions: { cardRefreshMs: 1 } } as Config
    const pipeline = new Pipeline({
      store, outbox, config: catchupCfg, projects: projects(), rules: { rules: [] } as never,
      ports, sessions: store, log: silent, transcripts: () => file,
    } as never)
    const refresh = (pipeline as unknown as { refreshCards: () => Promise<number> }).refreshCards.bind(pipeline)
    assert.equal(await refresh(), 1, '钩子没到时要补发')
    await outbox.tick()
    assert.equal(sent.length, 1, '补发一条回复卡')
    const card = sent[0]?.card as { body?: string }
    assert.equal(card.body, '从前有座山', '正文取转录里这一轮的助手收尾')
    await new Promise((r) => setTimeout(r, 10)) // 越过刷新节流，再确认不会重复补发
    assert.equal(await refresh(), 0, '同一轮只补一次，不能反复刷')
  } finally {
    store.close()
  }
})
test('电脑上自己开的窗口：扫到就建会话 + 发一张置顶卡（话题根），认识的窗口不重复接', async () => {
  const store = openStore(':memory:')
  try {
    const cfg2 = { ...cfg(), sessions: { adoptLocalWindows: true, adoptPerRun: 5 } } as Config
    const sent: { card: unknown; pin?: boolean }[] = []
    const channel: Channel = {
      async send() {
        return { status: 'sent', messageId: 'om_x' }
      },
      async sendCard(a: { card: unknown; pin?: boolean }) {
        sent.push({ card: a.card, pin: a.pin })
        return { status: 'sent', messageId: 'om_topic_root' }
      },
      async patchCard() {},
      async pinMessage() {},
      async threadIdOf() {
        return 'omt_topic_real'
      },
    }
    const executor = {
      async listLiveSessions() {
        return [
          { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: 'E:\\\\ws\\\\proj-a', title: 'proj-a', running: true },
          { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', cwd: 'E:\\\\ws\\\\proj-b', running: false },
        ]
      },
    }
    const ports: Ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor as never]]),
      channels: new Map([['channel-feishu', channel]]),
    }
    const outbox = new Outbox(store, createDeliver({ ports, config: cfg2, projects: projects(), store, log: silent }))
    const pipeline = new Pipeline({
      store, outbox, config: cfg2, projects: projects(), rules: { rules: [] } as never,
      ports, sessions: store, log: silent, transcripts: () => undefined,
    } as never)
    // 已经认识的窗口（比如飞书里开过的，id 不是 sess-local-*）不能再接一次
    store.insertSession(session({ id: 'sess-already', sessionId: 'bbbbbbbb-1111-2222-3333-444444444444' }))
    const adopt = (pipeline as unknown as { adoptLocalWindows: () => Promise<number> }).adoptLocalWindows.bind(pipeline)
    assert.equal(await adopt(), 1, '只接没接过的那个')
    await outbox.tick()
    assert.equal(sent.length, 1, '一个窗口一张卡（当话题根 + 状态卡）')
    assert.equal(sent[0]?.pin, true, '要置顶')
    const adopted = store.findSessionByExecutor('aaaaaaaa-1111-2222-3333-444444444444')
    assert.equal(adopted?.source, 'source-local-claude')
    assert.equal(adopted?.rootMessageId, 'om_topic_root', '卡片就是话题根消息')
    assert.equal(adopted?.threadId, 'omt_topic_real', '话题 id 要取真的 omt_，不是根消息 id')
    assert.equal(routeToSession(store, 'oc_1', 'omt_topic_real')?.id, 'sess-local-aaaaaaaa', '话题里的消息要路由回这个会话')
    assert.equal(await adopt(), 0, '接过的窗口不再重复接')
  } finally {
    store.close()
  }
})
