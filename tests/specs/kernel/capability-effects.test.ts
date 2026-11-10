import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities } from '../../../src/kernel/capabilities.ts'
import { ConfigSchema, type Config, type Projects } from '../../../src/kernel/config.ts'
import { createEffectRouter } from '../../../src/kernel/effect-router.ts'
import { EventLog } from '../../../src/kernel/event-log.ts'
import { registerKernelCapabilities } from '../../../src/kernel/kernel-capabilities.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'
import { createGate } from '../../../src/kernel/policy.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Action } from '../../../src/domain/types.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'
import type { Ruleset } from '../../../src/routing/rules.ts'

const silent = (): void => {}
const rules: Ruleset = { rules: [], allowlist: { groups: [], people: [], keywords: [] } }

const work = {
  id: 'w-1',
  intentId: 'e-1',
  kind: 'session' as const,
  project: 'proj',
  executor: 'dsh' as const,
  workspace: 'E:\\ws\\proj',
  prompt: '修登录',
  status: 'queued' as const,
}

async function actionOf(name: string, payload: unknown): Promise<Action> {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      executor_policies: { dsh: { plugin: 'executor-dsh', allowRoots: ['E:\\ws'] } },
    })
    const projects: Projects = { workspaces: [] }
    const ports = {
      sources: new Map(),
      channels: new Map(),
      classifiers: new Map(),
      executors: new Map(),
    } as unknown as Ports
    const eventLog = new EventLog(store, { log: silent })
    const outbox = new Outbox(store, async () => {}, { log: silent })
    const capabilities = new Capabilities(store, {
      log: silent,
      gate: createGate({ config, store, log: silent }),
      enqueue: createEffectRouter({ store, outbox, config, projects }),
    })
    registerKernelCapabilities({ capabilities, config, projects, rules, ports, store, log: silent })
    await capabilities.submit(name, payload, { caller: 'test', opKey: `${name}-1` })
    const row = store.listOutbox('pending', 1)[0]
    assert.ok(row, `${name} 应该入队`)
    return row.action
  } finally {
    store.close()
  }
}

test('九分支能力化：提交后的 Action 与旧 createDeliver 分支一一对应', async () => {
  assert.equal((await actionOf('session.dispatch', { work })).kind, 'dispatch_session')
  assert.equal((await actionOf('session.start', { work })).kind, 'start_session')
  const close = await actionOf('session.close', { sessionId: 's-1' })
  assert.equal(close.kind, 'stop_session')
  assert.equal(close.kind === 'stop_session' ? close.keepExecutor : false, true)
  assert.equal((await actionOf('session.post', { sessionId: 's-1', text: '继续' })).kind, 'post_message')
  assert.equal((await actionOf('session.stop', { sessionId: 's-1' })).kind, 'stop_session')
  assert.equal(
    (await actionOf('notify.reply', { target: { channel: 'feishu', chatId: 'oc_1' }, text: '好' })).kind,
    'reply_only',
  )
  assert.equal(
    (await actionOf('notify.card.send', { chatId: 'oc_1', card: { id: 'c1' } })).kind,
    'card_send',
  )
  assert.equal(
    (await actionOf('notify.card.patch', { chatId: 'oc_1', messageId: 'om_1', card: {} })).kind,
    'card_patch',
  )
  assert.equal(
    (await actionOf('notify.card.upsert', { sessionId: 's-1', card: { id: 'c1' }, signature: 'sig' })).kind,
    'card_upsert',
  )
  assert.equal((await actionOf('notify.card.pin', { sessionId: 's-1', pin: true })).kind, 'pin_card')
})
