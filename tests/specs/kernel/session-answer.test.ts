import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigSchema, type Config, type Projects } from '../../../src/kernel/config.ts'
import { createDeliver } from '../../../src/kernel/pipeline.ts'
import { openStore } from '../../../src/kernel/store.ts'
import type { Channel, Executor } from '../../../src/domain/ports.ts'
import type { Ports } from '../../../src/kernel/wiring.ts'

const silent = (): void => {}
const t = '2026-11-04T00:00:00Z'

test('session.answer：记录答案并投给执行器', async () => {
  const store = openStore(':memory:')
  try {
    const config: Config = ConfigSchema.parse({
      store: { path: ':memory:' },
      mode: 'auto',
      channels: { feishu: { plugin: 'channel-feishu', defaultChatId: 'oc_1' } },
      executor_policies: { claude: { plugin: 'executor-claude', allowRoots: ['E:\\ws'] } },
    })
    const projects: Projects = {
      workspaces: [
        {
          id: 'proj',
          name: 'Proj',
          kind: 'repo',
          root: 'E:\\ws\\proj',
          executor: 'claude',
          isolation: 'session',
          concurrency: 1,
          freshSession: true,
          aliases: [],
        },
      ],
    }
    const posted: string[] = []
    const executor = {
      start: async () => ({ executor: 'claude', sessionId: 'exec-1', workspace: 'E:\\ws\\proj' }),
      read: async () => [],
      stop: async () => {},
      post: async (_h: unknown, text: string) => {
        posted.push(text)
      },
    } as unknown as Executor
    const channel = { send: async () => ({ status: 'sent' }) } as unknown as Channel
    const ports = {
      sources: new Map(),
      channels: new Map([['channel-feishu', channel]]),
      classifiers: new Map(),
      executors: new Map([['executor-claude', executor]]),
    } as unknown as Ports
    const deliver = createDeliver({ ports, config, projects, store, log: silent })
    store.insertSession({
      id: 'sess-1',
      chatId: 'oc_1',
      threadId: 'th_1',
      executor: 'claude',
      workspace: 'proj',
      sessionId: 'exec-1',
      status: 'active',
      createdAt: t,
      lastActiveAt: t,
    })
    store.insertQuestion({
      id: 'q1',
      sessionId: 'sess-1',
      questions: [{ question: '选哪个方案' }],
      createdAt: t,
      expiresAt: t,
    })
    await deliver(
      { kind: 'answer_question', sessionId: 'sess-1', questionId: 'q1', answers: { '选哪个方案': 'A' } },
      'ans-1',
    )
    assert.equal(store.getQuestion('q1')?.answers['选哪个方案'], 'A')
    assert.equal(posted.length, 1)
    assert.match(posted[0] ?? '', /A/)
  } finally {
    store.close()
  }
})
