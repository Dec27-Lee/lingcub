import assert from 'node:assert/strict'
import { openStore } from '../../../src/kernel/store.ts'
import { test } from 'node:test'

import { decideAutoReply, policyProblem, triggerHits, type Facts, type Policy } from '../../../src/routing/auto-reply.ts'

const stopped = (over: Partial<Facts> = {}): Facts => ({ busy: false, text: '改完了', idleSeconds: 0, ...over })

test('自动回复：策略从上往下，先命中的生效', () => {
  const policies: Policy[] = [
    { reply: '先这句', triggers: [{ when: 'stopped', match: [{ mode: 'contains', text: '改完了' }] }] },
    { reply: '后这句', triggers: [{ when: 'stopped' }] },
  ]
  assert.equal(decideAutoReply(policies, stopped())?.reply, '先这句')
})

test('自动回复：关掉的策略永不触发', () => {
  const policies: Policy[] = [
    { reply: '不该发', enabled: false, triggers: [{ when: 'stopped' }] },
    { reply: '该发', triggers: [{ when: 'stopped' }] },
  ]
  assert.equal(decideAutoReply(policies, stopped())?.reply, '该发')
})

test('自动回复：三种比对方式；正则写错当作不命中，不卡住其他条件', () => {
  const mk = (mode: 'prefix' | 'contains' | 'regex', text: string): Policy => ({
    reply: 'x',
    triggers: [{ when: 'stopped', match: [{ mode, text }] }],
  })
  assert.ok(decideAutoReply([mk('prefix', 'API Error')], stopped({ text: 'API Error: 429' })))
  assert.equal(decideAutoReply([mk('prefix', 'API Error')], stopped({ text: '前面还有字 API Error' })), null)
  assert.ok(decideAutoReply([mk('contains', 'rate limit')], stopped({ text: 'got RATE LIMIT here' })), '大小写不敏感')
  assert.ok(decideAutoReply([mk('regex', '\\d{3}')], stopped({ text: 'code 429' })))
  assert.equal(decideAutoReply([mk('regex', '([bad')], stopped({ text: 'anything' })), null, '正则写错 = 不命中')
})

test('自动回复：afterSeconds 要等够时间；busy 时不按「停下」判', () => {
  const p: Policy = { reply: '继续', triggers: [{ when: 'stopped', afterSeconds: 900 }] }
  assert.equal(decideAutoReply([p], stopped({ idleSeconds: 100 })), null, '还没安静够')
  assert.ok(decideAutoReply([p], stopped({ idleSeconds: 901 })))
  assert.equal(decideAutoReply([p], { busy: true, busySeconds: 5000 }), null, '正在跑的一轮不算停下')
})

test('自动回复：busy 时机按已跑时长判，且不看内容', () => {
  const p: Policy = { reply: '要不要我接着做', triggers: [{ when: 'busy', busySeconds: 1800 }] }
  assert.equal(decideAutoReply([p], { busy: true, busySeconds: 100 }), null)
  assert.ok(decideAutoReply([p], { busy: true, busySeconds: 1801 }))
  assert.equal(decideAutoReply([p], stopped()), null, '已经停了就不算 busy')
})

test('自动回复：busy 条件里填比对文本要报错（语义不对，别悄悄按错的跑）', () => {
  const bad: Policy = {
    reply: 'x',
    triggers: [{ when: 'busy', busySeconds: 60, match: [{ mode: 'contains', text: '啊' }] }],
  }
  assert.match(policyProblem(bad) ?? '', /busy 时不能填比对文本/)
  assert.equal(policyProblem({ reply: '', triggers: [{ when: 'stopped' }] }), '自动回复内容不能为空')
  assert.match(policyProblem({ reply: 'x', triggers: [] }) ?? '', /至少要配一个触发条件/)
})

test('自动回复事实：Stop 之后记为「停了」，投递之后记为「在跑」', () => {
  const store = openStore(':memory:')
  try {
    const t = new Date().toISOString()
    store.insertSession({
      id: 's1',
      chatId: 'oc_1',
      threadId: 'omt_1',
      title: 'x',
      executor: 'claude',
      workspace: 'w',
      sessionId: 'exec-1',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    store.markStopped('s1', '改完了')
    const f1 = store.sessionFacts('s1')!
    assert.equal(f1.lastText, '改完了')
    assert.ok(f1.lastStopAt, '要记下结束时间')

    // 冷却：同一个窗口冷却期内只自动回一次
    assert.equal(store.canAutoReply('s1', 60_000), true)
    store.markAutoReplied('s1')
    assert.equal(store.canAutoReply('s1', 60_000), false)
    assert.equal(store.canAutoReply('s1', 0), true)
  } finally {
    store.close()
  }
})

test('触发判据：不填比对文本就只看时机', () => {
  assert.ok(triggerHits({ when: 'stopped' }, stopped()))
  assert.equal(triggerHits({ when: 'stopped', match: [{ mode: 'contains', text: '没出现' }] }, stopped()), null)
})

test('自动回复真的投进窗口：策略命中 → 发件箱 → 执行器 post（带来源标记）', async () => {
  const { Outbox } = await import('../../../src/kernel/outbox.ts')
  const { createDeliver, Pipeline } = await import('../../../src/kernel/pipeline.ts')

  const store = openStore(':memory:')
  try {
    const t = new Date().toISOString()
    store.insertSession({
      id: 'sess-a',
      chatId: 'oc_1',
      threadId: 'omt_a',
      rootMessageId: 'om_root',
      title: '修订单分页',
      executor: 'dsh',
      workspace: 'w',
      sessionId: 'exec-a',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    // 这一轮已经结束（Stop 钩子会写这两个字段）
    store.markStopped('sess-a', '分页改好了')

    const posted: string[] = []
    const executor = {
      async start() {
        return { executor: 'dsh' as const, sessionId: 'x', workspace: 'w' }
      },
      async read() {
        return []
      },
      async stop() {},
      async post(_h: unknown, text: string) {
        posted.push(text)
      },
    }
    const ports = {
      sources: new Map(),
      classifiers: new Map(),
      executors: new Map([['executor-dsh', executor]]),
      channels: new Map(),
    }
    const config = {
      mode: 'auto',
      store: { path: ':memory:' },
      log: { level: 'info' },
      sources: {},
      channels: {},
      classifiers: {},
      rules: [],
      executor_policies: { dsh: { plugin: 'executor-dsh' } },
      sessions: { newTopicPolicy: 'judge', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 60_000 },
      auto_reply: {
        enabled: true,
        pollSeconds: 0.001,
        cooldownSeconds: 60,
        policies: [{ reply: '继续把剩下的改完', enabled: true, triggers: [{ when: 'stopped' }] }],
      },
      projects: { workspaces: [] },
    } as never

    const outbox = new Outbox(
      store,
      createDeliver({
        ports: ports as never,
        config: config as never,
        projects: { workspaces: [{ id: 'w', root: 'E:\\w' }] } as never,
        store,
        log: (() => {}) as never,
      }),
    )
    const pipeline = new Pipeline({
      store,
      outbox,
      config: config as never,
      projects: { workspaces: [{ id: 'w', root: 'E:\\w' }] } as never,
      rules: { rules: [] } as never,
      ports: ports as never,
      sessions: store,
      log: (() => {}) as never,
    })

    assert.equal(await pipeline.autoReplyTick(), 1, '策略应当命中一次')
    await outbox.tick()
    assert.equal(posted.length, 1, '应当投递一次')
    assert.match(posted[0]!, /\[来自用户本人 · 自动回复\][\s\S]*继续把剩下的改完/, '正文要带来源标记，终端里一眼看出不是本人打的')

    // 冷却期内不再发。先把「这一轮又安静着」这个事实再摆一次：
    // 否则刚投递过会被判成 busy（在跑的一轮不算停下），测到的就不是冷却而是状态。
    store.markStopped('sess-a', '分页改好了')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(await pipeline.autoReplyTick(), 0, '冷却期内不该再次命中')
    await outbox.tick()
    assert.equal(posted.length, 1, '冷却期内不该重复投递')
  } finally {
    store.close()
  }
})
