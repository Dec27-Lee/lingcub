import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as consoleScene from '../../../src/plugins/scenario-console/index.ts'
import type { Session } from '../../../src/domain/types.ts'

const silent = (): void => {}

function session(): Session {
  return {
    id: 's1',
    chatId: 'oc_1',
    threadId: 'th_1',
    rootMessageId: 'om_root',
    executor: 'claude',
    workspace: 'proj',
    status: 'active',
    createdAt: '2026-11-04T00:00:00Z',
    lastActiveAt: '2026-11-04T00:00:00Z',
  }
}

function mount() {
  const handlers = new Map<string, (e: { payload: unknown }) => Promise<void>>()
  const submitted: { name: string; input: unknown }[] = []
  const ctx = {
    config: consoleScene.manifest.config.parse({}),
    has: () => true,
    log: silent,
    on: (kind: string, fn: never) => {
      handlers.set(kind, fn)
    },
    call: async (name: string) => {
      if (name === 'state.session.route') return session()
      if (name === 'state.workspace.get') return { root: 'E:\\ws\\proj' }
      if (name === 'state.session.history')
        return [
          { executor: 'claude', sessionId: 'old-1', cwd: 'E:\\ws\\proj', title: '旧会话', running: false },
          { executor: 'claude', sessionId: 'busy-1', cwd: 'E:\\ws\\proj', title: '在跑', running: true },
        ]
      if (name === 'state.session.live')
        return [{ executor: 'dsh', sessionId: 'live-1', cwd: 'E:\\ws\\live', title: '在跑', running: true }]
      return null
    },
    submit: async (name: string, input: unknown) => {
      submitted.push({ name, input })
      return { receiptId: 1, status: 'submitted' }
    },
  }
  consoleScene.setup(ctx as never)
  const run = async (kind: string, payload: unknown): Promise<void> => {
    const fn = handlers.get(kind)
    assert.ok(fn, `没有注册 ${kind}`)
    await fn({ payload })
  }
  return { run, submitted }
}

test('#resume：列出未在跑的历史会话，卡片带 sid/rebind', async () => {
  const m = mount()
  await m.run('message.received', {
    id: 'ev1',
    source: 'source-feishu-im',
    externalId: 'om1',
    receivedAt: '2026-11-04T00:00:00Z',
    occurredAt: '2026-11-04T00:00:00Z',
    actor: { id: 'u1' },
    channel: { kind: 'group', id: 'oc_1' },
    text: '#resume',
    raw: {},
    threadId: 'th_1',
  })
  const card = m.submitted.find((s) => s.name === 'notify.card.send')?.input as {
    card: { elements: { tag: string; actions?: { value: Record<string, string> }[] }[] }
  }
  const buttons = card.card.elements.find((e) => e.tag === 'action')?.actions ?? []
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0]?.value['sid'], 'old-1')
  assert.equal(buttons[0]?.value['rebind'], 's1')
  assert.equal(buttons[0]?.value['exec'], 'claude')
})

test('#resume 回调：session.start 带 resumeSessionId 与 rebind', async () => {
  const m = mount()
  await m.run('card.action', {
    id: 'card1',
    chatId: 'oc_1',
    messageId: 'om_card',
    action: {
      k: 'resume',
      sid: 'old-1',
      cwd: 'E:\\ws\\proj',
      exec: 'claude',
      rebind: 's1',
      thread: 'th_1',
      root: 'om_root',
      chat: 'oc_1',
    },
    rawAction: {},
  })
  const start = m.submitted.find((s) => s.name === 'session.start')?.input as {
    work: { resumeSessionId: string; origin: { rebindSessionId: string }; workspace: string }
  }
  assert.equal(start.work.resumeSessionId, 'old-1')
  assert.equal(start.work.origin.rebindSessionId, 's1')
  assert.equal(start.work.workspace, 'E:\\ws\\proj')
})

test('#接入：列出在跑会话，卡片回 attach', async () => {
  const m = mount()
  await m.run('message.received', {
    id: 'ev2',
    source: 'source-feishu-im',
    externalId: 'om2',
    receivedAt: '2026-11-04T00:00:00Z',
    occurredAt: '2026-11-04T00:00:00Z',
    actor: { id: 'u1' },
    channel: { kind: 'group', id: 'oc_1' },
    text: '#接入',
    raw: {},
    threadId: 'th_1',
    rootId: 'om_root',
  })
  const card = m.submitted.find((s) => s.name === 'notify.card.send')?.input as {
    card: { elements: { tag: string; actions?: { value: Record<string, string> }[] }[] }
  }
  const buttons = card.card.elements.find((e) => e.tag === 'action')?.actions ?? []
  assert.equal(buttons[0]?.value['k'], 'attach')
  assert.equal(buttons[0]?.value['sid'], 'live-1')
})

test('#接入 回调：session.attach 带话题与执行器会话', async () => {
  const m = mount()
  await m.run('card.action', {
    id: 'card2',
    chatId: 'oc_1',
    messageId: 'om_card',
    action: {
      k: 'attach',
      sid: 'live-1',
      cwd: 'E:\\ws\\live',
      exec: 'dsh',
      thread: 'th_1',
      root: 'om_root',
      chat: 'oc_1',
    },
    rawAction: {},
  })
  const attach = m.submitted.find((s) => s.name === 'session.attach')?.input as {
    executorSessionId: string
    threadId: string
    executor: string
  }
  assert.equal(attach.executorSessionId, 'live-1')
  assert.equal(attach.threadId, 'th_1')
  assert.equal(attach.executor, 'dsh')
})
