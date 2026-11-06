import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startSources } from '../src/kernel/source-start.ts'
import type { Source } from '../src/domain/ports.ts'
import type { Ports } from '../src/kernel/wiring.ts'

const silent = (): void => {}

function source(name: string, calls: string[]): Source {
  return {
    start: async () => {
      calls.push(`start:${name}`)
    },
    stop: async () => {
      calls.push(`stop:${name}`)
    },
  }
}

test('来源启动：旧 sources 段与 v2 注册端口都启动，同一插件不重复', async () => {
  const calls: string[] = []
  const ports = {
    sources: new Map([
      ['channel-feishu', source('channel-feishu', calls)],
      ['source-feishu-card-v2', source('source-feishu-card-v2', calls)],
      ['source-dingtalk', source('source-dingtalk', calls)],
    ]),
    classifiers: new Map(),
    executors: new Map(),
    channels: new Map(),
  } as unknown as Ports
  const s = await startSources({
    ports,
    sources: {
      feishu: { enabled: true, plugin: 'channel-feishu' },
      off: { enabled: false, plugin: 'missing' },
    },
    v2Plugins: ['source-feishu-card-v2'],
    emit: () => {},
    log: silent,
  })
  assert.deepEqual(calls, ['start:channel-feishu', 'start:source-feishu-card-v2'])
  assert.deepEqual(s.started, ['feishu', 'plugin:source-feishu-card-v2'])
  await s.stop()
  assert.deepEqual(calls.slice(2), ['stop:source-feishu-card-v2', 'stop:channel-feishu'])
})
