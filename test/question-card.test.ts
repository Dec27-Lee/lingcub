import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderQuestionCard, renderSettledCard } from '../src/plugins/channel-feishu/card.ts'

test('题卡：多选时把勾选态画在按钮上（☑ / ☐）', () => {
  const card = renderQuestionCard({
    id: 'q1',
    question: '改哪几个？',
    options: [{ label: '甲' }, { label: '乙' }],
    index: 1,
    total: 1,
    multiSelect: true,
    chatId: 'oc_1',
    selected: ['乙'],
  }) as { elements?: { actions?: { text?: { content?: string } }[] }[] }
  const texts = (card.elements ?? [])
    .flatMap((e) => e.actions ?? [])
    .map((b) => b.text?.content ?? '')
  assert.ok(texts.includes('☑ 2. 乙'), `勾上的要显示 ☑，实际：${texts.join(' / ')}`)
  assert.ok(texts.includes('☐ 1. 甲'), '没勾的显示 ☐')
})

test('题卡：单选不画勾选框（单选点了就答完，没有「待提交」这回事）', () => {
  const card = renderQuestionCard({
    id: 'q1',
    question: '选一个',
    options: [{ label: '甲' }],
    index: 1,
    total: 1,
    multiSelect: false,
    chatId: 'oc_1',
    selected: ['甲'],
  }) as { elements?: { actions?: { text?: { content?: string } }[] }[] }
  const texts = (card.elements ?? []).flatMap((e) => e.actions ?? []).map((b) => b.text?.content ?? '')
  assert.ok(texts.includes('1. 甲'), '单选按钮不带 ☑/☐')
})

test('回执卡：答完之后说清「答案已送回」和选了什么', () => {
  const card = renderSettledCard({ question: '改哪几个？', answer: '甲, 丙' }) as {
    header?: { title?: { content?: string } }
    elements?: { content?: string }[]
  }
  assert.match(card.header?.title?.content ?? '', /已把答案送回窗口/)
  const body = (card.elements ?? []).map((e) => e.content ?? '').join('\n')
  assert.match(body, /改哪几个？/)
  assert.match(body, /甲, 丙/)
})

test('答题后：题卡原地变回执；还有下一题就接着推一张', async () => {
  const { openStore } = await import('../src/kernel/store.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const { Pipeline } = await import('../src/kernel/pipeline.ts')
  const store = openStore(':memory:')
  try {
    const actions: { kind: string; card?: unknown; messageId?: string }[] = []
    const outbox = new Outbox(store, async (a) => {
      actions.push(a as never)
    })
    const t = new Date().toISOString()
    store.insertSession({
      id: 's1',
      chatId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
      title: '改订单页',
      executor: 'claude',
      workspace: 'E:\\w',
      sessionId: 'exec-1',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    store.insertQuestion({
      id: 'q-two',
      sessionId: 's1',
      questions: [{ question: '第一题：用哪个方案？', options: [{ label: '甲' }, { label: '乙' }] }, { question: '第二题：要不要加缓存？', options: [{ label: '要' }] }],
      createdAt: t,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    store.setQuestionCard('q-two', 'om_card_1')

    const pipeline = new Pipeline({
      store,
      outbox,
      config: {
        mode: 'auto',
        sessions: { newTopicPolicy: 'open', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 60_000 },
        executor_policies: {},
        channels: {},
        sources: {},
        classifiers: {},
        auto_reply: { enabled: false, pollSeconds: 5, cooldownSeconds: 60, policies: [] },
        cleanup: { enabled: false },
        contextWindow: 200_000,
      } as never,
      projects: { workspaces: [] },
      rules: { rules: [] } as never,
      ports: { sources: new Map(), classifiers: new Map(), executors: new Map(), channels: new Map() } as never,
      sessions: store,
      log: () => {},
    } as never)

    await pipeline.ingest({
      id: 'e1',
      source: 'source-feishu-card',
      externalId: 'e1',
      receivedAt: t,
      occurredAt: t,
      actor: { id: 'ou_1' },
      channel: { kind: 'group' as const, id: 'oc_1' },
      rootId: 'om_root',
      text: JSON.stringify({ k: 'ans', qid: 'q-two', label: '甲' }),
      raw: { type: 'card.action.trigger', event_id: 'e1', chat_id: 'oc_1' },
    })
    await outbox.tick()

    const patch = actions.find((a) => a.kind === 'card_patch')
    assert.ok(patch, '答完要把题卡改成回执')
    assert.equal(patch?.messageId, 'om_card_1')
    assert.equal((patch?.card as { kind?: string }).kind, 'settled')
    assert.equal((patch?.card as { answer?: string }).answer, '甲')

    const next = actions.find((a) => a.kind === 'card_send')
    assert.ok(next, '还有一题没答，要接着推')
    const nextCard = next?.card as { question?: string; index?: number; total?: number }
    assert.match(nextCard.question ?? '', /第二题/)
    assert.equal(nextCard.index, 2)
    assert.equal(nextCard.total, 2)
  } finally {
    store.close()
  }
})

test('多选点选：原地刷新题卡的勾选态', async () => {
  const { openStore } = await import('../src/kernel/store.ts')
  const { Outbox } = await import('../src/kernel/outbox.ts')
  const { Pipeline } = await import('../src/kernel/pipeline.ts')
  const store = openStore(':memory:')
  try {
    const actions: { kind: string; card?: unknown }[] = []
    const outbox = new Outbox(store, async (a) => {
      actions.push(a as never)
    })
    const t = new Date().toISOString()
    store.insertSession({
      id: 's2', chatId: 'oc_1', threadId: 'omt_2', rootMessageId: 'om_root2', title: 't',
      executor: 'claude', workspace: 'E:\\w', sessionId: 'exec-2', status: 'active', createdAt: t, lastActiveAt: t,
    })
    store.insertQuestion({
      id: 'q-multi', sessionId: 's2',
      questions: [{ question: '改哪几个？', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }],
      createdAt: t, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    store.setQuestionCard('q-multi', 'om_card_m')
    const pipeline = new Pipeline({
      store, outbox,
      config: {
        mode: 'auto',
        sessions: { newTopicPolicy: 'open', choiceTtlMs: 60_000, replyCooldownMs: 0, cardRefreshMs: 60_000 },
        executor_policies: {}, channels: {}, sources: {}, classifiers: {},
        auto_reply: { enabled: false, pollSeconds: 5, cooldownSeconds: 60, policies: [] },
        cleanup: { enabled: false }, contextWindow: 200_000,
      } as never,
      projects: { workspaces: [] }, rules: { rules: [] } as never,
      ports: { sources: new Map(), classifiers: new Map(), executors: new Map(), channels: new Map() } as never,
      sessions: store, log: () => {},
    } as never)

    await pipeline.ingest({
      id: 'e2', source: 'source-feishu-card', externalId: 'e2', receivedAt: t, occurredAt: t,
      actor: { id: 'ou_1' }, channel: { kind: 'group' as const, id: 'oc_1' }, rootId: 'om_root2',
      text: JSON.stringify({ k: 'ans', qid: 'q-multi', label: '乙' }),
      raw: { type: 'card.action.trigger', event_id: 'e2', chat_id: 'oc_1' },
    })
    await outbox.tick()
    const patch = actions.find((a) => a.kind === 'card_patch')?.card as { kind?: string; selected?: string[] }
    assert.equal(patch?.kind, 'question', '勾选态是刷新题卡本身，不是换成回执')
    assert.deepEqual(patch?.selected, ['乙'])
  } finally {
    store.close()
  }
})
