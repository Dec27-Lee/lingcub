import { stableCardSignature, statusCardSignature } from '../../../src/kernel/card-content.ts'
import { isTurnOpen } from '../../../src/kernel/transcript.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigSchema, type Config } from '../../../src/kernel/config.ts'
import { createDeliver, Pipeline } from '../../../src/kernel/pipeline.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Channel, Executor } from '../../../src/domain/ports.ts'
import type { Session } from '../../../src/domain/types.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }
const t = '2026-11-06T06:30:00Z'
const WS = 'E:\\Develop_E\\lingcub'

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-live',
    chatId: 'oc_1',
    threadId: 'om_root',
    title: '修订单分页',
    executor: 'claude',
    // v2 开窗后存的是真实 cwd（不是 projects.yaml 的 id）
    workspace: WS,
    sessionId: 'c510e321',
    status: 'active',
    createdAt: t,
    lastActiveAt: t,
    ...over,
  }
}

async function mount(cardRefreshMs = 2000) {
  const store = openStore(':memory:')
  const config: Config = ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
    executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\Develop_E'] } },
    sessions: { cardRefreshMs },
  })
  const sent: { chatId: string; replyTo?: string; card: Record<string, unknown> }[] = []
  const patched: string[] = []
  const channel = {
    async send() {
      return { status: 'sent' }
    },
    async sendCard(a: { chatId: string; replyTo?: string; card: Record<string, unknown> }) {
      sent.push(a)
      return { status: 'sent', messageId: `om_card_${sent.length}` }
    },
    async patchCard(id: string) {
      patched.push(id)
    },
    async pinMessage() {},
  } as unknown as Channel
  const executor: Executor = {
    async start() {
      return { executor: 'claude', sessionId: 'c510e321', workspace: WS }
    },
    async read() {
      return [
        { at: t, kind: 'output', text: '正在改订单分页的接口' },
        { at: t, kind: 'output', text: '改完了，跑了一遍测试' },
      ]
    },
    async stop() {},
  }
  const ports = {
    sources: new Map(),
    classifiers: new Map(),
    executors: new Map([['executor-claude', executor]]),
    channels: new Map([['channel-feishu', channel]]),
  } as unknown as Ports
  const projects = { workspaces: [] }
  const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, log: silent }), { log: silent })
  const pipeline = new Pipeline({ store, outbox, config, projects, rules, ports, sessions: store, log: silent })
  return { store, outbox, pipeline, sent, patched }
}

test('状态卡：v2 建出来的会话（workspace 是绝对 cwd）也能出卡并回到话题', async () => {
  const m = await mount()
  try {
    m.store.insertSession(session())
    const n = await m.pipeline.refreshCards()
    assert.ok(n > 0, '应当为活跃会话排一张卡')
    await m.outbox.tick()
    assert.equal(m.sent.length, 1, '第一拍发新卡')
    assert.equal(m.sent[0]?.chatId, 'oc_1')
    assert.equal(m.sent[0]?.replyTo, 'om_root', '卡要回在话题里')
    const body = JSON.stringify(m.sent[0]?.card)
    assert.match(body, /修订单分页/)
    assert.match(body, /改完了|正在改订单分页/)
  } finally {
    m.store.close()
  }
})

test('状态卡：内容没变不重发（刷新节流 + 发件箱去重 + 签名三层挡住）', async () => {
  // 把刷新节流调到 1ms，才能在一片卡上验证「签名去重」本身，而不是被节流挡住
  const m = await mount(1)
  try {
    m.store.insertSession(session())
    await m.pipeline.refreshCards()
    await m.outbox.tick()
    assert.equal(m.sent.length, 1)
    await new Promise((r) => setTimeout(r, 10))
    // 同一份进度再来一拍：节流已过，靠签名判断不该再发
    await m.pipeline.refreshCards()
    await m.outbox.tick()
    assert.equal(m.sent.length, 1, '内容没变就不该刷屏')
  } finally {
    m.store.close()
  }
})
test('卡片签名：秒级文案抖动不算变化（否则每 2 秒 patch 一次飞书）', () => {
  const a = { title: 't', status: 'running', lines: ['🟢 正在运行 · 已 3 分 12 秒', '📁 E:\\x'] }
  const b = { title: 't', status: 'running', lines: ['🟢 正在运行 · 已 3 分 47 秒', '📁 E:\\x'] }
  const c = { title: 't', status: 'running', lines: ['🟢 正在运行 · 已 4 分 2 秒', '📁 E:\\x'] }
  assert.equal(stableCardSignature(a as never), stableCardSignature(b as never), '同一分钟内的秒数抖动要同签名')
  assert.notEqual(stableCardSignature(a as never), stableCardSignature(c as never), '分钟变了就是新内容')
  const d = { title: 't', status: 'idle', lines: ['⚪ 本轮结束 · 12 秒前', '📁 E:\\x'] }
  const e = { title: 't', status: 'idle', lines: ['⚪ 本轮结束 · 40 秒前', '📁 E:\\x'] }
  assert.equal(stableCardSignature(d as never), stableCardSignature(e as never))
  const f = { title: 't', status: 'idle', lines: ['🚨 出错了', '📁 E:\\x'] }
  assert.notEqual(stableCardSignature(d as never), stableCardSignature(f as never), '内容真的变了要能识别')
})
test('turn 是否还在跑：人刚说完=在跑；助手收尾=结束；工具调用没回填=在跑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-open-'))
  const mk = (lines: unknown[]) => {
    const f = join(dir, `t-${Math.random().toString(16).slice(2)}.jsonl`)
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
    return f
  }
  const user = { type: 'user', message: { content: [{ type: 'text', text: '把分页改掉' }] } }
  const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }
  const assistantTool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } }
  const assistantText = { type: 'assistant', message: { content: [{ type: 'text', text: '好的，改完了' }] } }

  assert.equal(isTurnOpen(mk([user])), true, '人刚说完还在等回复')
  assert.equal(isTurnOpen(mk([user, assistantTool, toolResult])), true, '工具调用还没回填')
  assert.equal(isTurnOpen(mk([user, assistantTool, toolResult, assistantText])), false, '助手正文收尾 = 本轮结束')
  assert.equal(isTurnOpen(join(dir, 'nope.jsonl')), false, '读不到转录就当没在跑')
})
test('状态卡签名：只有秒级文案变化时签名不变（否则每 5 秒 patch 一次飞书，把投递队列堵死）', () => {
  const a = statusCardSignature({ title: 't', status: 'done', lines: ['⚪ 本轮结束 · 18 分 57 秒前', '📁 `E:\\x`'] })
  const b = statusCardSignature({ title: 't', status: 'done', lines: ['⚪ 本轮结束 · 18 分 3 秒前', '📁 `E:\\x`'] })
  const c = statusCardSignature({ title: 't', status: 'done', lines: ['⚪ 本轮结束 · 19 分 0 秒前', '📁 `E:\\x`'] })
  assert.equal(a, b, '同一分钟内的秒级抖动不算变化')
  assert.notEqual(a, c, '跨分钟要算变化，卡才会跟着走')
})
