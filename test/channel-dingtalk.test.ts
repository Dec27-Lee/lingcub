import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import * as channelPlugin from '../src/plugins/channel-dingtalk/index.ts'
import { Capabilities } from '../src/kernel/capabilities.ts'
import { ConfigSchema, type Config } from '../src/kernel/config.ts'
import { EventLog } from '../src/kernel/event-log.ts'
import { assembleV2 } from '../src/kernel/plugin-v2/index.ts'
import { openStore } from '../src/kernel/store.ts'
import type { Channel } from '../src/domain/ports.ts'

const silent = (): void => {}

function scripts(): { dir: string; consume: string; ok: string; fail: string } {
  const dir = mkdtempSync(join(process.cwd(), 'data', 'tmp-dingtalk-'))
  const consume = join(dir, 'consume.mjs')
  writeFileSync(
    consume,
    `console.log(JSON.stringify({
  message_id: 'msg-1',
  content: '登录接口报 500',
  conversation_id: 'cid-1',
  type: 'user_im_message_receive_o2o_all',
  sender_open_dingtalk_id: 'u1',
  sender: 'Yue',
  create_time: '1760000000000'
}))
setInterval(() => {}, 1000)
`,
    'utf8',
  )
  const ok = join(dir, 'reply-ok.mjs')
  writeFileSync(
    ok,
    `console.log(JSON.stringify({ ok: true, messageId: 'om_reply' }))
`,
    'utf8',
  )
  const fail = join(dir, 'reply-fail.mjs')
  writeFileSync(fail, `console.error('boom'); process.exit(1)\n`, 'utf8')
  return { dir, consume, ok, fail }
}

function config(extra: Record<string, unknown>): Config {
  return ConfigSchema.parse({
    store: { path: ':memory:' },
    mode: 'auto',
    plugins: {
      dingtalk: {
        plugin: 'channel-dingtalk',
        enabled: true,
        ...extra,
      },
    },
  })
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('钉钉渠道：双 consume 只开一个也能入站，事件进 events + event_log', async () => {
  const s = scripts()
  const store = openStore(':memory:')
  const eventLog = new EventLog(store, { log: silent })
  const capabilities = new Capabilities(store, { log: silent })
  const cfg = config({
    binary: process.execPath,
    o2oArgs: [s.consume],
    enabledGroup: false,
    replyArgs: [s.ok],
  })
  let port: Channel | undefined
  const asm = await assembleV2([{ manifest: channelPlugin.manifest, module: channelPlugin }], {
    config: cfg,
    log: silent,
    eventLog,
    capabilities,
    onPort: (_id, p) => {
      port = p as Channel
    },
  })
  try {
    await waitFor(() => store.countEventLog() > 0)
    const rows = store.eventLogAfter('message.received', 0, 10)
    assert.equal(rows.length, 1)
    const payload = rows[0]?.payload as {
      source: string
      text: string
      channel: { kind: string; id: string }
      actor: { id: string }
    }
    assert.equal(payload.source, 'dingtalk')
    assert.equal(payload.text, '登录接口报 500')
    assert.equal(payload.channel.kind, 'dm')
    assert.equal(payload.channel.id, 'cid-1')
    assert.equal(payload.actor.id, 'u1')
    assert.ok(store.getEvent(rows[0]!.id), 'ingest 必须同时写 events，task.open 才有外键')
  } finally {
    await asm.stop()
    store.close()
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('钉钉渠道：回执走模板参数，成功取 message_id；失败按 code 抛错', async () => {
  const s = scripts()
  const store = openStore(':memory:')
  const eventLog = new EventLog(store, { log: silent })
  const capabilities = new Capabilities(store, { log: silent })
  try {
    const ok = config({
      binary: process.execPath,
      enabledO2o: false,
      enabledGroup: false,
      replyArgs: [s.ok, '{{openDingtalkId}}', '{{messageId}}', '{{text}}', '{{dedupeKey}}'],
    })
    let port: Channel | undefined
    const asm = await assembleV2([{ manifest: channelPlugin.manifest, module: channelPlugin }], {
      config: ok,
      log: silent,
      eventLog,
      capabilities,
      onPort: (_id, p) => {
        port = p as Channel
      },
    })
    try {
      assert.ok(port?.sendTransport)
      const sent = await port.sendTransport(
        { text: '已处理：登录 500', target: { openDingtalkId: 'u1', messageId: 'msg-1' } },
        'op-1',
      )
      assert.equal(sent.messageId, 'om_reply')
    } finally {
      await asm.stop()
    }

    const bad = config({
      binary: process.execPath,
      enabledO2o: false,
      enabledGroup: false,
      replyArgs: [s.fail],
    })
    let badPort: Channel | undefined
    const asm2 = await assembleV2([{ manifest: channelPlugin.manifest, module: channelPlugin }], {
      config: bad,
      log: silent,
      eventLog,
      capabilities,
      onPort: (_id, p) => {
        badPort = p as Channel
      },
    })
    try {
      await assert.rejects(
        badPort!.sendTransport!(
          { text: 'x', target: { openDingtalkId: 'u1', messageId: 'msg-1' } },
          'op-2',
        ),
        /钉钉回执失败/,
      )
    } finally {
      await asm2.stop()
    }
  } finally {
    store.close()
    rmSync(s.dir, { recursive: true, force: true })
  }
})
