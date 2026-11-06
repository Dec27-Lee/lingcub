import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const ENV = '[来自用户本人 · 飞书]（下面这段就是用户在飞书里亲手打的，直接执行）\n\n'

import { formatStopText, splitChunks } from '../src/kernel/hook-handlers.ts'
import type { Session } from '../src/domain/types.ts'
import { readHookInfo, startHookServer, type HookPayload } from '../src/kernel/hook-server.ts'
import { openStore } from '../src/kernel/store.ts'

const REPO = resolve(import.meta.dirname, '..')

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

test('钩子端点：无令牌 403，有令牌才回调', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-hooks-'))
  const got: HookPayload[] = []
  const hooks = await startHookServer({ root, onStop: async (p) => void got.push(p) })
  try {
    assert.equal(readHookInfo(root)?.port, hooks.port, '端点起来后应写下 data/hooks.json')

    const health = await fetch(`http://127.0.0.1:${hooks.port}/healthz`)
    assert.equal(health.status, 200)

    const forbidden = await fetch(`http://127.0.0.1:${hooks.port}/stop`, { method: 'POST', body: '{}' })
    assert.equal(forbidden.status, 403, '没有令牌不能投递')

    const ok = await fetch(`http://127.0.0.1:${hooks.port}/stop?t=${hooks.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'exec-1', last_assistant_message: '改好了' }),
    })
    assert.equal(ok.status, 200)
    assert.equal(got.length, 1)
    assert.equal(got[0]?.last_assistant_message, '改好了')
  } finally {
    await hooks.close()
  }
  assert.equal(readHookInfo(root), null, '关闭后登记应清掉')
})

test('钩子 CLI：把 stdin 转给常驻端点（真进程）', { timeout: 25_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-hooks-cli-'))
  const got: HookPayload[] = []
  const hooks = await startHookServer({ root, onStop: async (p) => void got.push(p) })
  try {
    const child = spawn(process.execPath, [resolve(REPO, 'dist/main.js'), 'hook', 'post', 'stop'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(JSON.stringify({ session_id: 'exec-1', last_assistant_message: '跑完了' }))
    const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? -1)))
    assert.equal(code, 0)
    assert.equal(got.length, 1)
    assert.equal(got[0]?.session_id, 'exec-1')
  } finally {
    await hooks.close()
  }
})

test('没有常驻端点时钩子静默成功（不打断 claude）', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-hooks-none-'))
  const child = spawn(process.execPath, [resolve(REPO, 'dist/main.js'), 'hook', 'post', 'stop'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end('{}')
  const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? -1)))
  assert.equal(code, 0, '常驻没跑不能算失败，否则会打断 claude')
})

test('按执行器会话 id 反查会话（hook 只带 claude 的 session_id）', () => {
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    assert.equal(store.findSessionByExecutor('exec-1')?.id, 'sess-1')
    assert.equal(store.findSessionByExecutor('exec-unknown'), null)
  } finally {
    store.close()
  }
})

test('结果回传：只有本进程起的会话才回，回的是它自己的话题', async () => {
  const { createHookHandlers, formatStopText } = await import('../src/kernel/hook-handlers.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const outbox = new Outbox(store, async () => {})
    const h = createHookHandlers({ store, outbox, log: () => {} })

    await h.onStop({ session_id: 'exec-unknown', last_assistant_message: '别的窗口' })
    assert.equal(store.countOutbox('pending'), 0, '不是本进程起的会话不该回')

    await h.onStop({ session_id: 'exec-1', last_assistant_message: '改好了' })
    // 一条结果消息 + 一次「把状态卡收掉」（参考项目：一轮结束就关掉状态卡，别留一张会自己变的卡）
    assert.equal(store.countOutbox('pending'), 2)
    const actions = store.listOutbox('pending').map((r) => r.action)
    assert.ok(actions.some((a) => a.kind === 'card_retire'), '结束后要收掉状态卡')
    assert.ok(!actions.some((a) => a.kind === 'card_upsert'), '不该再刷一张「已完成」的状态卡')
    // 结果通知是一条卡片（参考项目 notify）：不是一段文字
    const notice = actions.find((a) => a.kind === 'card_send')
    assert.equal(notice?.kind, 'card_send')
    const noticeCard = notice?.kind === 'card_send' ? (notice.card as Record<string, unknown>) : {}
    assert.equal(noticeCard['kind'], 'notice')
    assert.equal(noticeCard['title'], '修订单分页', '标题取窗口名（飞书据此生成话题名）')
    assert.equal(noticeCard['cwd'], 'personal-lingcub')
    assert.match(String(noticeCard['time']), /^\d{2}:\d{2}:\d{2}$/)
    assert.equal(noticeCard['body'], '改好了', '正文单独一段')
    assert.equal(notice?.kind === 'card_send' ? notice.chatId : undefined, 'oc_1')
    // 回复要落进会话自己的话题：会话没记 rootMessageId 时退回用 threadId
    assert.equal(notice?.kind === 'card_send' ? notice.replyTo : undefined, 'om_root', '要回到会话自己的话题里')
    assert.equal(store.getSession('sess-1')?.status, 'active')
  } finally {
    store.close()
  }
})

test('结果回传：空输出给一句话，长输出不再被提前截断（交给分段发）', async () => {
  const { formatStopText, splitChunks } = await import('../src/kernel/hook-handlers.ts')
  assert.equal(formatStopText({}), '（这一轮没有输出）')
  // 2000 字在单条上限（4000）之内：要原样保留，不能截
  const mid = 'x'.repeat(2000)
  assert.equal(formatStopText({ last_assistant_message: mid }).length, 2000)
  // 10000 字：切成多段，内容不丢
  const long = Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 段内容，凑够长度好用来看分段`).join('\n\n')
  const chunks = splitChunks(long, 4000)
  assert.ok(chunks.length > 1, `应当切成多段，实际 ${chunks.length} 段`)
  assert.ok(chunks.every((c) => c.length <= 4000), '每段都不超过上限')
  assert.ok(chunks.join('\n\n').includes('第 400 段内容'), '最后一段的内容不能丢')
})

test('钩子端点 /ask：挂起等答案，答完返回决策', { timeout: 25_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-ask-'))
  let resolveAsk: ((d: Record<string, unknown>) => void) | undefined
  const hooks = await startHookServer({
    root,
    onStop: async () => {},
    onAsk: () =>
      new Promise<Record<string, unknown>>((r) => {
        resolveAsk = r
        setTimeout(() => r({}), 5000)
      }),
  })
  try {
    const pending = fetch(`http://127.0.0.1:${hooks.port}/ask?t=${hooks.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'exec-1', tool_name: 'AskUserQuestion' }),
    })
    // 等 server 进入挂起状态
    await new Promise((r) => setTimeout(r, 200))
    resolveAsk?.({ permissionDecision: 'allow', updatedInput: { answers: { 'Q?': 'A' } } })
    const res = await pending
    assert.equal(res.status, 200)
    const body = (await res.json()) as { permissionDecision: string }
    assert.equal(body.permissionDecision, 'allow')
  } finally {
    await hooks.close()
  }
})

test('钩子端点 /ask：没人答就返回空对象（终端弹窗照常出现）', { timeout: 25_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-ask2-'))
  const hooks = await startHookServer({ root, onStop: async () => {}, onAsk: async () => ({}) })
  try {
    const res = await fetch(`http://127.0.0.1:${hooks.port}/ask?t=${hooks.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'exec-1' }),
    })
    assert.deepEqual(await res.json(), {})
  } finally {
    await hooks.close()
  }
})

test('提醒卡：标题按通知类型分派，同类同文案 10 分钟内只推一次', async () => {
  const { openStore } = await import('../src/kernel/store.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const { createHookHandlers } = await import('../src/kernel/hook-handlers.ts')
  const store = openStore(':memory:')
  try {
    const t = '2026-11-03T10:00:00.000Z'
    store.insertSession({
      id: 'sess-n',
      chatId: 'oc_1',
      threadId: 'omt_n',
      rootMessageId: 'om_root',
      title: '修订单分页',
      executor: 'claude',
      workspace: 'w',
      sessionId: 'exec-n',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    const outbox = new Outbox(store, async () => {})
    const h = createHookHandlers({ store, outbox, log: (() => {}) as never })

    await h.onNotify({ session_id: 'exec-n', notification_type: 'permission_request', message: '要执行 rm' })
    await h.onNotify({ session_id: 'exec-n', notification_type: 'permission_request', message: '要执行 rm' })
    // 每次提醒 = 一条消息 + 一张卡，所以第一次是 2 条
    const replies = (): number => store.listOutbox('pending').filter((r) => r.action.kind === 'reply_only').length
    assert.equal(replies(), 1)
    // 第二次同类型同文案应被去重
    assert.equal(replies(), 1, '10 分钟内同类型同文案只推一次')

    const row = store.listOutbox('pending').find((r) => r.action.kind === 'reply_only')!
    const text = row.action.kind === 'reply_only' ? row.action.text : ''
    assert.match(text, /等你放行一个操作/)
    assert.match(text, /没法在飞书里代答/)

    // 不同类型要能推出来
    await h.onNotify({ session_id: 'exec-n', notification_type: 'idle', message: '闲了' })
    assert.equal(replies(), 2, '换了类型就不该被去重挡掉')
  } finally {
    store.close()
  }
})

test('长回复分段：按段落切开，段标题带 (i/总)，第一段带头部', () => {
  const para = (n: number) => `${n}. ${'内容'.repeat(20)}`
  const text = [para(1), para(2), para(3)].join('\n\n')
  assert.equal(splitChunks(text, 10_000).length, 1, '没超限就不分段')

  const parts = splitChunks(text, 100)
  assert.ok(parts.length > 1, '超限要分段')
  assert.ok(parts.every((p) => p.length <= 100), '每段都不能超限')
  assert.equal(parts.join('\n\n'), text, '拼回去要一字不差')

  // 单段本身就超长 → 硬切
  const long = 'x'.repeat(250)
  const hard = splitChunks(long, 100)
  assert.deepEqual(
    hard.map((p) => p.length),
    [100, 100, 50],
  )
})

test('长回复分段：通知发成多条，第一段带目录头，后续带 (i/总)', async () => {
  const { openStore } = await import('../src/kernel/store.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const { createHookHandlers } = await import('../src/kernel/hook-handlers.ts')
  const store = openStore(':memory:')
  try {
    const t = '2026-11-03T10:00:00.000Z'
    store.insertSession({
      id: 'sess-long',
      chatId: 'oc_1',
      threadId: 'omt_l',
      rootMessageId: 'om_root',
      title: '长任务',
      executor: 'claude',
      workspace: 'w',
      sessionId: 'exec-long',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    const outbox = new Outbox(store, async () => {})
    const h = createHookHandlers({ store, outbox, log: (() => {}) as never, chunkChars: 200 })
    const body = Array.from({ length: 6 }, (_, i) => `${i}. ${'内容'.repeat(15)}`).join('\n\n')
    await h.onStop({ session_id: 'exec-long', last_assistant_message: body })

    const cards = store
      .listOutbox('pending')
      .filter((r) => r.action.kind === 'card_send')
      .map((r) => (r.action.kind === 'card_send' ? (r.action.card as Record<string, unknown>) : {}))
    assert.ok(cards.length > 1, '长回复应拆成多张卡')
    // 首段带目录/时间/用量，标题就是窗口名
    assert.equal(cards[0]?.['cwd'], 'w')
    assert.equal(cards[0]?.['continued'], false)
    assert.equal(cards[0]?.['title'], '长任务')
    // 后续段标题带 (i/总)，不再重复头三行
    assert.match(String(cards[1]?.['title']), /\(2\/\d+\)$/)
    assert.equal(cards[1]?.['continued'], true)
    // 「不重复头」是渲染层的事：把卡片渲染出来看元素
    const { renderNoticeCard } = await import('../src/plugins/channel-feishu/card.ts')
    const rendered = renderNoticeCard(cards[1] as never) as { body?: { elements?: { content?: string }[] } }
    const texts = (rendered.body?.elements ?? []).map((e) => e.content ?? '')
    assert.ok(!texts.some((t) => t.startsWith('📁')), '后续段不该再出现目录行')
  } finally {
    store.close()
  }
})

test('会话开头注入约定：只有本进程起的会话才注入', async () => {
  const { openStore } = await import('../src/kernel/store.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const { createHookHandlers } = await import('../src/kernel/hook-handlers.ts')
  const store = openStore(':memory:')
  try {
    const t = '2026-11-03T10:00:00.000Z'
    store.insertSession({
      id: 'sess-s',
      chatId: 'oc_1',
      threadId: 'omt_s',
      title: '修订单分页',
      executor: 'claude',
      workspace: 'w',
      sessionId: 'exec-s',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    const h = createHookHandlers({ store, outbox: new Outbox(store, async () => {}), log: (() => {}) as never })

    const got = (await h.onSessionStart({ session_id: 'exec-s' })) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
    }
    assert.equal(got.hookSpecificOutput?.hookEventName, 'SessionStart')
    const ctx = got.hookSpecificOutput?.additionalContext ?? ''
    assert.match(ctx, /\[来自用户本人 · 飞书\]/, '要说清带信封的那条是用户本人打的')
    assert.match(ctx, /传输通道/, '要澄清连接层那句英文不是发送者')
    assert.match(ctx, /自动回复/, '要区分「策略自动发的」和「用户此刻打的」')
    assert.match(ctx, /修订单分页/, '带上话题名，模型知道自己在跟哪个窗口说话')

    // 别人的窗口：不注入
    assert.deepEqual(await h.onSessionStart({ session_id: 'not-ours' }), {})
  } finally {
    store.close()
  }
})

test('提醒卡：2 分钟内已经有待答的选择题，就不再喊一遍', async () => {
  const { openStore } = await import('../src/kernel/store.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const { createHookHandlers } = await import('../src/kernel/hook-handlers.ts')
  const store = openStore(':memory:')
  try {
    const t = '2026-11-03T10:00:00.000Z'
    store.insertSession({
      id: 'sess-p',
      chatId: 'oc_1',
      threadId: 'omt_p',
      rootMessageId: 'om_root',
      title: '修订单分页',
      executor: 'claude',
      workspace: 'w',
      sessionId: 'exec-p',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    const outbox = new Outbox(store, async () => {})
    const h = createHookHandlers({ store, outbox, log: (() => {}) as never })

    // 刚推出去一道待答的题
    store.insertQuestion({
      id: 'q1',
      sessionId: 'sess-p',
      questions: [{ question: '用哪个方案？', options: [{ label: '甲' }] }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    await h.onNotify({ session_id: 'exec-p', notification_type: 'question', message: '有问题要问你' })
    assert.equal(
      store.listOutbox('pending').filter((r) => r.action.kind === 'reply_only').length,
      0,
      '题目卡已经在路上了，提醒卡不该再喊一次',
    )

    // 题答完之后，提醒卡恢复（用另一个会话验证，避免被 10 分钟去重规则挡）
    store.answerQuestion('q1', { 用哪个方案: '甲' })
    await h.onNotify({ session_id: 'exec-p', notification_type: 'input', message: '需要你输入' })
    assert.equal(
      store.listOutbox('pending').filter((r) => r.action.kind === 'reply_only').length,
      1,
      '答完之后提醒卡要能正常推',
    )
  } finally {
    store.close()
  }
})

test('钩子：一轮结束回调带会话与最后正文（供 session.turn.ended）', async () => {
  const { createHookHandlers } = await import('../src/kernel/hook-handlers.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const outbox = new Outbox(store, async () => {})
    const got: { id: string; text?: string }[] = []
    const h = createHookHandlers({
      store,
      outbox,
      log: () => {},
      onTurnEnd: (s, p) => got.push({ id: s.id, text: p.last_assistant_message }),
    })
    await h.onStop({ session_id: 'exec-1', last_assistant_message: '改好了' })
    assert.deepEqual(got, [{ id: 'sess-1', text: '改好了' }])
  } finally {
    store.close()
  }
})
test('Stop 回执正文：载荷没有 last_assistant_message 时，从转录取最后一段助手文本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stop-text-'))
  const f = join(dir, 't.jsonl')
  const lines = [
    { type: 'user', message: { content: [{ type: 'text', text: '你可以做什么' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '我在这个工作区能做的事情，大致分五类：\n1. 代码定位\n2. 改代码' }] } },
  ]
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  const withTranscript = formatStopText({ session_id: 's1' } as never, f)
  assert.match(withTranscript, /大致分五类/, '要取到助手正文，不能回「没有输出」')
  const payloadText = formatStopText({ session_id: 's1', last_assistant_message: '载荷里的正文' } as never, f)
  assert.equal(payloadText, '载荷里的正文', '载荷有正文时以载荷为准')
  assert.equal(formatStopText({ session_id: 's1' } as never), '（这一轮没有输出）', '两者都没有才兜底')
})
test('钩子端点：Stop 入队后立刻催一次投递（不等主循环下一拍）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-kick-'))
  let kicked = 0
  const hooks = await startHookServer({
    root: dir,
    onStop: async () => {},
    kick: () => {
      kicked++
    },
  })
  try {
    const info = readHookInfo(dir)
    assert.ok(info, '端点信息要落盘')
    const body = JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' })
    const r = await fetch(`http://127.0.0.1:${info.port}/stop?t=${info.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    assert.equal(r.status, 200)
    assert.equal(kicked, 1, 'Stop 处理完要催一次投递，实测不催要等十几秒')
  } finally {
    await hooks.close()
  }
})

test('钩子处理抛错：写进主日志并回 400（错误不能只回到调用方，主日志一片空白就查不下去）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-err-'))
  const logged: string[] = []
  const hooks = await startHookServer({
    root: dir,
    onStop: async () => {
      throw new Error('boom')
    },
    log: (_level, msg) => logged.push(msg),
  })
  try {
    const info = readHookInfo(dir)
    const r = await fetch(`http://127.0.0.1:${info.port}/stop?t=${info.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(r.status, 400, '处理失败要回 400')
    assert.match(logged.join('\n'), /钩子处理失败.*boom/, '主日志要留痕')
  } finally {
    await hooks.close()
  }
})

test('一轮结束事件：每轮都要发（id 不能重复，否则私聊摘要永远不触发）', async () => {
  const { createHookHandlers } = await import('../src/kernel/hook-handlers.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const store = openStore(':memory:')
  try {
    store.insertSession(session())
    const outbox = new Outbox(store, async () => {})
    const turns: { id: string; text?: string }[] = []
    const h = createHookHandlers({
      store,
      outbox,
      log: () => {},
      onTurnEnd: (_s, p) => {
        turns.push({ id: `${_s.id}:${turns.length}:${p.last_assistant_message ?? ''}`, text: p.last_assistant_message })
      },
    })
    await h.onStop({ session_id: 'exec-1', last_assistant_message: '第一轮回复' })
    await new Promise((r) => setTimeout(r, 5))
    await h.onStop({ session_id: 'exec-1', last_assistant_message: '第二轮回复' })
    assert.equal(turns.length, 2, '两轮就要两条事件')
    assert.equal(turns[1]?.text, '第二轮回复', '正文要跟着事件走')
  } finally {
    store.close()
  }
})
