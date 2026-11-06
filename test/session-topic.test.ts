import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStore } from '../src/kernel/store.ts'
import { routeToSession } from '../src/routing/session-route.ts'

/** 飞书话题 id 是 omt_…，开窗时手里只有根消息 om_…：两种都要能路由回同一个会话。 */
function bind(
  store: ReturnType<typeof openStore>,
  over: { id: string; threadId?: string; rootMessageId?: string },
): void {
  store.insertSession({
    id: over.id,
    chatId: 'oc_topic',
    source: 'source-feishu-im',
    threadId: over.threadId,
    rootMessageId: over.rootMessageId,
    executor: 'claude',
    workspace: 'E:\\work',
    status: 'active',
    createdAt: '2026-11-06T02:00:00.000Z',
    lastActiveAt: '2026-11-06T02:00:00.000Z',
  })
}

test('话题路由：只记了根消息 om_ 的会话，用根消息也能命中', () => {
  const store = openStore(':memory:')
  try {
    bind(store, { id: 's1', rootMessageId: 'om_root' })
    assert.equal(store.findSessionByThread('oc_topic', 'om_root')?.id, 's1')
  } finally {
    store.close()
  }
})

test('话题路由：真话题 id omt_ 命中；别的群不串', () => {
  const store = openStore(':memory:')
  try {
    bind(store, { id: 's2', threadId: 'omt_thread', rootMessageId: 'om_root2' })
    assert.equal(store.findSessionByThread('oc_topic', 'omt_thread')?.id, 's2')
    assert.equal(store.findSessionByThread('oc_topic', 'om_root2')?.id, 's2')
    assert.equal(store.findSessionByThread('oc_other', 'omt_thread'), null)
  } finally {
    store.close()
  }
})

test('话题路由：thread 命中优先于根消息命中（同群多条会话时不乱认）', () => {
  const store = openStore(':memory:')
  try {
    bind(store, { id: 'old', rootMessageId: 'om_shared' })
    bind(store, { id: 'exact', threadId: 'om_shared', rootMessageId: 'om_x' })
    assert.equal(store.findSessionByThread('oc_topic', 'om_shared')?.id, 'exact')
  } finally {
    store.close()
  }
})

test('话题路由：新话题第一条消息只有 rootId 时，用 rootId 也能找回会话', () => {
  const store = openStore(':memory:')
  try {
    // 开窗时手里只有锚消息 om_anchor；用户在这棵话题里的消息带 threadId=omt_ + rootId=om_anchor。
    bind(store, { id: 's3', threadId: 'om_anchor' })
    assert.equal(store.findSessionByThread('oc_topic', 'omt_new'), null, '还没见过真话题 id')
    assert.equal(store.findSessionByThread('oc_topic', 'om_anchor')?.id, 's3')
  } finally {
    store.close()
  }
})

test('会话路由：dead 会话不再接消息', () => {
  const store = openStore(':memory:')
  try {
    bind(store, { id: 's4', rootMessageId: 'om_dead' })
    store.setSessionStatus('s4', 'dead')
    assert.equal(routeToSession(store, 'oc_topic', 'om_dead'), null)
  } finally {
    store.close()
  }
})

test('执行器身份：库里存短 id、钩子给全 uuid 也要认得出（headless 结果能回来）', () => {
  const store = openStore(':memory:')
  try {
    store.insertSession({
      id: 's5',
      chatId: 'oc_topic',
      executor: 'claude',
      workspace: 'E:\\work',
      sessionId: 'c510e321',
      status: 'active',
      createdAt: '2026-11-06T02:00:00.000Z',
      lastActiveAt: '2026-11-06T02:00:00.000Z',
    })
    assert.equal(store.findSessionByExecutor('c510e321')?.id, 's5')
    assert.equal(store.findSessionByExecutor('c510e321-aaaa-bbbb-cccc-dddddddddddd')?.id, 's5')
    assert.equal(store.findSessionByExecutor('deadbeef'), null, '不相干的全 uuid 不能误撞')
    assert.equal(store.findSessionByExecutor('c510'), null, '短于 6 位不做前缀匹配')
  } finally {
    store.close()
  }
})

test('执行器身份：库里存全 uuid、钩子给短 id 也能认', () => {
  const store = openStore(':memory:')
  try {
    store.insertSession({
      id: 's6',
      chatId: 'oc_topic',
      executor: 'claude',
      workspace: 'E:\\work',
      sessionId: 'f08a0a77-1111-2222-3333-444455556666',
      status: 'active',
      createdAt: '2026-11-06T02:00:00.000Z',
      lastActiveAt: '2026-11-06T02:00:00.000Z',
    })
    assert.equal(store.findSessionByExecutor('f08a0a77')?.id, 's6')
  } finally {
    store.close()
  }
})
