import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { z } from 'zod'
import type { Channel, Executor, Work } from '../src/domain/ports.ts'
import { mapMessage, toIso } from '../src/plugin-kit/map.ts'
import { assertNoPlaceholders, renderArgs } from '../src/plugin-kit/template.ts'
import { pickMessageId } from '../src/plugins/channel-feishu/index.ts'
import * as channelFeishu from '../src/plugins/channel-feishu/index.ts'
import * as classifier from '../src/plugins/classifier-llm/index.ts'
import * as claude from '../src/plugins/executor-claude/index.ts'
import * as dsh from '../src/plugins/executor-dsh/index.ts'

const silent = (): void => {}

interface Mountable {
  manifest: { config: z.ZodTypeAny }
  setup: (ctx: never) => void
}

/** 用插件自己的 manifest 校验配置并 setup，拿到它注册的端口实现。 */
function mount<T>(mod: Mountable, raw: unknown): T {
  const config = mod.manifest.config.parse(raw)
  let impl: unknown = null
  ;(mod.setup as unknown as (ctx: unknown) => void)({
    config,
    log: silent,
    register: (i: unknown) => {
      impl = i
    },
  })
  assert.ok(impl, '插件没有注册端口实现')
  return impl as T
}

function work(over: Partial<Work> = {}): Work {
  return {
    id: 'w1',
    intentId: 'i1',
    kind: 'session',
    project: 'personal-lingcub',
    executor: 'dsh',
    workspace: 'E:\\Develop_E\\lingcub',
    prompt: '把导出按钮加上',
    status: 'queued',
    ...over,
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 飞书真实事件的形状（生产日志实测的 16 个扁平键）。 */
const feishuFields = {
  externalId: 'message_id',
  text: 'content',
  channelId: 'chat_id',
  channelType: 'chat_type',
  actorId: 'sender_id',
  occurredAt: 'create_time',
}

const feishuPayload = {
  type: 'event',
  event_id: 'evt_1',
  timestamp: '1792626931949',
  id: 'om_1',
  message_id: 'om_1',
  create_time: '1792626931949',
  update_time: '1792626931949',
  chat_id: 'oc_1',
  chat_type: 'group',
  message_type: 'text',
  sender_id: 'ou_1',
  sender_type: 'user',
  root_id: '',
  thread_id: '',
  reply_to: '',
  content: '登录页点导出报错 500',
}

test('飞书事件映射：扁平字段 → Event，毫秒时间戳转 ISO，atMe 留空不猜', () => {
  const m = mapMessage(feishuPayload, { source: 'source-feishu-im', fields: feishuFields, groupValues: ['group'] })
  assert.equal(m.ok, true)
  if (!m.ok) return
  assert.equal(m.event.externalId, 'om_1')
  assert.equal(m.event.text, '登录页点导出报错 500')
  assert.equal(m.event.channel.kind, 'group')
  assert.equal(m.event.channel.id, 'oc_1')
  assert.equal(m.event.actor.id, 'ou_1')
  assert.equal(m.event.occurredAt, new Date(1792626931949).toISOString())
  assert.equal(m.event.atMe, undefined)
})

test('私聊（p2p）映射为 dm', () => {
  const m = mapMessage(
    { ...feishuPayload, chat_type: 'p2p' },
    { source: 'source-feishu-im', fields: feishuFields, groupValues: ['group'] },
  )
  assert.equal(m.ok && m.event.channel.kind, 'dm')
})

test('钉钉 +listen-im all-direct：没有 channelType 也按来源声明映射为 dm', () => {
  const payload = {
    type: 'user_im_message_receive_o2o_all',
    message_id: 'msg_1',
    conversation_id: 'cid_1',
    sender: '张三',
    sender_open_dingtalk_id: 'open_1',
    content: '帮我看下登录 500',
    create_time: 1792626931949,
  }
  const m = mapMessage(payload, {
    source: 'source-dingtalk',
    fallbackChannelKind: 'dm',
    groupValues: [],
    fields: {
      externalId: 'message_id',
      text: 'content',
      channelId: 'conversation_id',
      actorId: 'sender_open_dingtalk_id',
      occurredAt: 'create_time',
      actorName: 'sender',
    },
  })
  assert.equal(m.ok, true)
  if (!m.ok) return
  assert.equal(m.event.channel.kind, 'dm')
  assert.equal(m.event.actor.id, 'open_1')
  assert.equal(m.event.text, '帮我看下登录 500')
})

test('缺字段时不静默：返回缺失清单与 payload 顶层键', () => {
  const { message_id: _drop, ...withoutId } = feishuPayload
  const m = mapMessage(withoutId, { source: 'source-feishu-im', fields: feishuFields, groupValues: ['group'] })
  assert.equal(m.ok, false)
  if (m.ok) return
  assert.ok(m.missing.some((s) => s.includes('message_id')))
  assert.ok(m.keys.includes('chat_id'))
})

test('时间戳兼容秒/毫秒/ISO，非法值回落到收到的时刻', () => {
  assert.equal(toIso('1792626931949', 'X'), new Date(1792626931949).toISOString())
  assert.equal(toIso('1792626931', 'X'), new Date(1792626931 * 1000).toISOString())
  assert.equal(toIso('2026-10-21T23:55:32.000Z', 'X'), '2026-10-21T23:55:32.000Z')
  assert.equal(toIso('不是时间', 'X'), 'X')
})

test('分类输出解析：纯 JSON / 事件包裹 / 代码围栏都能取到', () => {
  const answer = { kind: 'bug', topic: 't', suggestedAction: 'dispatch_session', rationale: 'r', confidence: 0.8 }
  assert.deepEqual(classifier.parseClassifierOutput(JSON.stringify(answer)), answer)
  assert.deepEqual(
    classifier.parseClassifierOutput(JSON.stringify({ type: 'text', text: JSON.stringify(answer) })),
    answer,
  )
  assert.deepEqual(
    classifier.parseClassifierOutput(
      ['{"type":"run"}', JSON.stringify({ type: 'text', text: '```json\n' + JSON.stringify(answer) + '\n```' })].join('\n'),
    ),
    answer,
  )
  assert.equal(classifier.parseClassifierOutput('什么都没给'), null)
})

test('参数模板：占位替换，缺变量直接失败', () => {
  assert.deepEqual(renderArgs(['-p', '{{prompt}}'], { prompt: '你好' }), ['-p', '你好'])
  assert.throws(() => assertNoPlaceholders(renderArgs(['{{budgetUsd}}'], {})), /未提供的变量/)
  assert.doesNotThrow(() => assertNoPlaceholders(renderArgs(['-x'], {})))
})

test('claude 执行器：第二道门禁拦住不在允许根内的工作区', async () => {
  const ex = mount<Executor>(claude, { allowRoots: [], binary: 'definitely-not-installed' })
  await assert.rejects(() => ex.start(work({ executor: 'claude' })), /不在允许根内/)
})

test('claude 执行器：没配预算就报错，不拿 0 当默认值', async () => {
  const ex = mount<Executor>(claude, { allowRoots: ['E:\\Develop_E'], binary: 'definitely-not-installed' })
  await assert.rejects(() => ex.start(work({ executor: 'claude' })), /未配置预算/)
})

test('dsh 执行器：真起子进程、收集进度、退出即完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dsh-'))
  const script = join(dir, 'emit.mjs')
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({ type: 'text', text: '收到：' + process.argv[2] }) + '\\n')\n`,
  )
  const ex = mount<Executor>(dsh, {
    binary: process.execPath,
    args: [script, '{{prompt}}'],
    allowRoots: ['E:\\Develop_E'],
  })
  const handle = await ex.start(work())
  try {
    const progresses = await waitFor(async () => {
      const ps = await ex.read(handle)
      return ps.some((p) => p.kind === 'finished') ? ps : null
    })
    assert.ok(progresses.some((p) => p.kind === 'output' && p.text?.includes('收到：把导出按钮加上')))
    assert.equal(progresses.at(-1)?.kind, 'finished')
  } finally {
    await ex.stop(handle)
  }
})

test('飞书频道：正文作为一段合法 JSON 传给 CLI（引号不破结构）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-ch-'))
  const out = join(dir, 'args.json')
  const script = join(dir, 'rec.mjs')
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`,
  )
  const ch = mount<Channel>(channelFeishu, {
    binary: process.execPath,
    args: [script, '{{chatId}}', '{{content}}'],
    defaultChatId: 'oc_9',
  })
  assert.deepEqual(await ch.send({ kind: 'reply_only', text: '他说"报错了"\n第二行' }, 'k1'), {
    status: 'sent',
    messageId: undefined,
  })
  const argv = JSON.parse(readFileSync(out, 'utf8')) as string[]
  assert.equal(argv[0], 'oc_9')
  assert.deepEqual(JSON.parse(argv[1] ?? '{}'), { text: '他说"报错了"\n第二行' })
})

test('飞书频道：没配 chatId 就报错，不往空处发', async () => {
  const ch = mount<Channel>(channelFeishu, { defaultChatId: '' })
  await assert.rejects(() => ch.send({ kind: 'reply_only', text: 'x' }, 'k1'), /defaultChatId 未配置/)
})

test('飞书频道：能从 CLI 输出里取到新消息 id（话题绑定要用）', () => {
  const stdout = [
    'INFO 发送中…',
    JSON.stringify({ ok: true, data: { message_id: 'om_777', chat_id: 'oc_1' } }),
  ].join('\n')
  assert.equal(pickMessageId(stdout, 'data.message_id'), 'om_777')
  assert.equal(pickMessageId('没有 JSON 输出', 'data.message_id'), undefined)
  assert.equal(pickMessageId('{"data":{}}', 'data.message_id'), undefined)
})

test('飞书频道：pinCards 且调用方要求置顶才置顶（就绪卡不置顶）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-pin-'))
  const log = join(dir, 'calls.ndjson')
  const script = join(dir, 'rec.mjs')
  writeFileSync(
    script,
    [
      "import { appendFileSync } from 'node:fs'",
      `const f=${JSON.stringify(log)}`,
      'appendFileSync(f, JSON.stringify(process.argv.slice(2))+"\\n")',
      'console.log(JSON.stringify({ data: { message_id: "om_card_1" } }))',
    ].join('\n'),
  )

  const mk = (pinCards: boolean) =>
    mount<Channel>(channelFeishu, {
      binary: process.execPath,
      args: [script, '{{chatId}}', '{{card}}'],
      cardArgs: [script, '{{chatId}}', '{{card}}'],
      pinCreateArgs: [script, 'pins-create', '{{messageId}}'],
      pinDeleteArgs: [script, 'pins-delete', '{{messageId}}'],
      defaultChatId: 'oc_9',
      pinCards,
    })

  const card = { title: 't', status: 'running', lines: [] }
  const on = mk(true)
  assert.equal((await on.sendCard!({ chatId: 'oc_9', card, pin: true }, 'k'))?.messageId, 'om_card_1')
  const callsOn = readFileSync(log, 'utf8').trim().split('\n')
  assert.ok(callsOn.some((l) => l.includes('pins-create')), '配了 pinCards 应置顶')
  assert.ok(callsOn[0]?.includes('om_card_1') === false, '第一条是发卡')

  assert.ok(callsOn.some((l) => l.includes('pins-create')), '要求置顶且配了 pinCards 应置顶')

  // 同一频道：没要求置顶（就绪卡/普通卡）就不置顶，免得一个窗口挂两条置顶
  writeFileSync(log, '')
  await on.sendCard!({ chatId: 'oc_9', card }, 'k1b')
  assert.ok(!readFileSync(log, 'utf8').includes('pins-create'), '调用方没要求就不置顶')

  writeFileSync(log, '')
  const off = mk(false)
  await off.sendCard!({ chatId: 'oc_9', card, pin: true }, 'k2')
  writeFileSync(script, 'process.stdout.write("backgrounded · af74099e\\n")')
  const ex = mount<Executor>(claude, {
    binary: process.execPath,
    args: [script, '{{prompt}}'],
    allowRoots: ['E:\\Develop_E'],
    defaultBudgetUsd: 1,
  })
  const handle = await ex.start(work({ executor: 'claude' }))
  assert.equal(handle.sessionId, 'af74099e', 'logs/stop 与管道查找都用这个短 id')
})

test('claude 执行器：拿不到后台会话 id 就明确失败，不猜', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-claude-bg2-'))
  const script = join(dir, 'bg2.mjs')
  writeFileSync(script, 'process.stdout.write("something unexpected")')
  const ex = mount<Executor>(claude, {
    binary: process.execPath,
    args: [script, '{{prompt}}'],
    allowRoots: ['E:\\Develop_E'],
    defaultBudgetUsd: 1,
  })
  await assert.rejects(() => ex.start(work({ executor: 'claude' })), /没有返回后台会话 id/)
})

test('飞书频道：多行美化 JSON 也能取到消息 id（实测形状）', () => {
  const pretty = [
    '{',
    '  "ok": true,',
    '  "identity": "bot",',
    '  "data": {',
    '    "chat_id": "oc_x",',
    '    "create_time": "2026-11-03 19:21:14",',
    '    "message_id": "om_x100b61a8746628acdf744c4fcd35bd6"',
    '  }',
    '}',
  ].join('\n')
  assert.equal(pickMessageId(pretty, 'data.message_id'), 'om_x100b61a8746628acdf744c4fcd35bd6')
  // 前面还有别的日志行时也要能取到
  assert.equal(pickMessageId(`INFO 发送中…\n${pretty}`, 'data.message_id'), 'om_x100b61a8746628acdf744c4fcd35bd6')
  // NDJSON 仍然支持
  assert.equal(pickMessageId('{"data":{"message_id":"om_1"}}', 'data.message_id'), 'om_1')
  assert.equal(pickMessageId('没有 JSON', 'data.message_id'), undefined)
})

test('飞书频道：取消置顶必须带 --yes（实测该接口属 high-risk-write）', () => {
  const ch = mount<Channel>(channelFeishu, { defaultChatId: 'oc_1', binary: process.execPath, args: ['x'] })
  void ch
  const defaults = channelFeishu.manifest.config.parse({})
  assert.ok(defaults.pinDeleteArgs.includes('--yes'), 'pins delete 不带 --yes 会被 CLI 拒绝')
  assert.ok(defaults.pinCreateArgs.length > 0)
})

test('claude 执行器：#resume 时把 --resume <id> 放进去', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-claude-resume-'))
  const script = join(dir, 'rec.mjs')
  const argsFile = join(dir, 'argv.json')
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write("backgrounded · beef1234\\n")`,
  )
  const ex = mount<Executor>(claude, {
    binary: process.execPath,
    args: [script, '{{prompt}}'],
    allowRoots: ['E:\\Develop_E'],
    defaultBudgetUsd: 1,
  })
  const w = work({ executor: 'claude' })
  const handle = await ex.start({ ...w, resumeSessionId: 'sess-old' })
  assert.equal(handle.sessionId, 'beef1234')
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const i = argv.indexOf('--resume')
  assert.ok(i >= 0, `启动参数里要有 --resume，实际：${argv.join(' ')}`)
  assert.equal(argv[i + 1], 'sess-old')
  assert.equal(argv.at(-1), w.prompt, '提示词仍然是最后一个位置参数')
})
