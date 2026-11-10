/**
 * 整条链路的离线端到端：假飞书 CLI + 假 claude CLI + 真内核。
 *
 * 覆盖顺序正是切生产后要跑的那一遍：群里说话 → 开窗 → 锚消息 → 状态卡 →
 * 钩子回传结果 → 话题内追加投递 → 命令。全程不碰真实订阅，所以可以和生产的桥接同时跑。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { runRuntime } from '../../../src/kernel/runtime.ts'
import { readHookInfo } from '../../../src/kernel/hook-server.ts'

const REPO = resolve(import.meta.dirname, '../../..')

/** 把一段 JS 写成一个可执行脚本，返回路径（用 node 直接跑）。 */
function script(dir: string, name: string, body: string): string {
  const file = join(dir, name)
  writeFileSync(file, body, 'utf8')
  try {
    chmodSync(file, 0o755)
  } catch {
    /* Windows 不需要 */
  }
  return file
}

function setup(opts: { twoWorkspaces?: boolean; autoReply?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-e2e-'))
  const bin = join(root, 'bin')
  const data = join(root, 'data')
  const wsRoot = join(root, 'ws')
  for (const d of [bin, data, wsRoot, join(root, 'config'), join(root, 'prompts')]) mkdirSync(d, { recursive: true })

  const calls = join(root, 'calls.ndjson')
  const wsFile = join(root, 'workspaces.json')

  // 假 lark-cli：发消息/发卡记一行，并回一个 message_id；event consume 吐一条事件后保持 stdin 打开
  const lark = script(
    bin,
    'lark.mjs',
    [
      "import { appendFileSync, readFileSync } from 'node:fs'",
      `const CALLS=${JSON.stringify(calls)}`,
      'const argv = process.argv.slice(2)',
      'appendFileSync(CALLS, JSON.stringify(argv) + "\\n")',
      'const [, , , , msgTypeIndex] = argv',
      'if (argv[0] === "event" && argv[2] === "card.action.trigger") {',
      // 卡片回调：等测试写下 card-action.json 再吐一条，模拟有人点了按钮
      '  const f = ' + JSON.stringify(join(root, 'card-action.json')),
      '  const { existsSync, readFileSync } = await import("node:fs")',
      '  const t0 = Date.now()',
      '  const timer = setInterval(() => {',
      '    if (existsSync(f)) { clearInterval(timer); process.stdout.write(readFileSync(f, "utf8").trim() + "\\n") }',
      '    else if (Date.now() - t0 > 60000) clearInterval(timer)',
      '  }, 100)',
      '  setInterval(() => {}, 1000)',
      '  process.stdin.resume()',
      '} else if (argv[0] === "event") {',
      `  const ws = JSON.parse(readFileSync(${JSON.stringify(wsFile)}, "utf8"))`,
      '  const ev = { type: "event", event_id: "e1", message_id: "om_first", create_time: String(Date.now()),',
      '    chat_id: "oc_1", chat_type: "group", message_type: "text", sender_id: "ou_1",',
      '    root_id: "", thread_id: "", reply_to: "", content: ws.title }',
      '  setTimeout(() => process.stdout.write(JSON.stringify(ev) + "\\n"), 50)',
      '  setInterval(() => {}, 1000)   // 保持打开，模拟长连接',
      '  process.stdin.resume()',
      '} else {',
      '  process.stdout.write(JSON.stringify({ ok: true, data: { message_id: "om_" + Date.now() + "_" + Math.random().toString(16).slice(2, 6) } }) + "\\n")',
      '}',
    ].join('\n'),
  )

  // 假 claude：--bg 起会话时回一个 session id，并把自己登记进 ~/.claude/sessions 让自己「活着」
  // 假 claude：--bg 起会话时回一个短 id，并把自己登记进会话表（含命名管道地址）
  const claudeBody = [
    "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    `const CALLS = ${JSON.stringify(calls)}`,
    `const ROOT = ${JSON.stringify(root)}`,
    'const argv = process.argv.slice(2)',
    'appendFileSync(CALLS, JSON.stringify(["claude", ...argv]) + "\\n")',
    'const short = ("af" + Math.random().toString(16).slice(2, 8)).slice(0, 8)',
    'const full = short + "-1111-2222-3333-444444444444"',
    'const dir = join(ROOT, "claude-sessions")',
    'mkdirSync(dir, { recursive: true })',
    // Windows 的命名管道必须 \\.\\pipe\\<名字>；用 join 拼避免在源码里写一堆反斜杠
    "const PIPE = process.platform === 'win32' ? ['', '', '.', 'pipe', 'lingcub-e2e-' + short].join('\\\\') : join(dir, short + '.sock')",
    'try {',
    '  writeFileSync(join(dir, short + ".json"), JSON.stringify({ sessionId: full, pid: process.pid, messagingSocketPath: PIPE, cwd: process.cwd() }))',
    '  writeFileSync(join(ROOT, "pipe-path.txt"), PIPE)',
    '} catch {}',
    'writeFileSync(join(ROOT, "short-id.txt"), short)',
    'const cmd = argv[0]',
    'if (cmd === "logs") process.stdout.write("fake logs")',
    'else if (cmd === "stop") process.stdout.write("stopped")',
    'else process.stdout.write("backgrounded · " + short + "\\n")',
  ].join('\n')
  const claude = script(bin, 'claude.mjs', claudeBody)

  writeFileSync(
    join(root, 'config/lingcub.yaml'),
    [
      'mode: auto',
      'log: { level: "debug" }',
      'store: { path: data/lingcub.db }',
      'sessions:',
      '  newTopicPolicy: open',
      '  choiceTtlMs: 60000',
      '  replyCooldownMs: 0',
      'contextWindow: 200000',
      ...(opts.autoReply
        ? [
            'auto_reply:',
            '  enabled: true',
            '  pollSeconds: 1',
            '  cooldownSeconds: 0',
            '  policies:',
            "    - reply: '继续把剩下的改完'",
            '      enabled: true',
            '      triggers:',
            '        - when: stopped',
          ]
        : []),
      'sources:',
      '  feishu-im:',
      '    enabled: true',
      '    plugin: source-feishu-im',
      `    binary: ${JSON.stringify(process.execPath)}`,
      '    args:',
      `      - ${JSON.stringify(lark)}`,
      '      - event',
      '      - consume',
      '      - im.message.receive_v1',
      '    groupValues: [group]',
      '  feishu-card:',
      '    enabled: true',
      '    plugin: source-feishu-card',
      `    binary: ${JSON.stringify(process.execPath)}`,
      '    args:',
      `      - ${JSON.stringify(lark)}`,
      '      - event',
      '      - consume',
      '      - card.action.trigger',
      '  dingtalk-im:',
      '    enabled: false',
      '    plugin: source-dingtalk',
      '    fields:',
      '      externalId: msgId',
      '      text: text',
      '      channelId: conversationId',
      '      channelType: conversationType',
      '      actorId: senderStaffId',
      'channels:',
      '  feishu:',
      '    plugin: channel-feishu',
      '    defaultChatId: oc_1',
      `    binary: ${JSON.stringify(process.execPath)}`,
      '    args:',
      `      - ${JSON.stringify(lark)}`,
      '      - im',
      '      - +messages-send',
      '      - --as',
      '      - bot',
      '      - --chat-id',
      '      - "{{chatId}}"',
      '      - --msg-type',
      '      - text',
      '      - --content',
      '      - "{{content}}"',
      '    replyArgs:',
      '      - ' + JSON.stringify(lark),
      '      - im',
      '      - +messages-reply',
      '      - --as',
      '      - bot',
      '      - --message-id',
      '      - "{{replyTo}}"',
      '      - --reply-in-thread',
      '      - --msg-type',
      '      - text',
      '      - --content',
      '      - "{{content}}"',
      '    cardReplyArgs:',
      '      - ' + JSON.stringify(lark),
      '      - im',
      '      - +messages-reply',
      '      - --as',
      '      - bot',
      '      - --message-id',
      '      - "{{replyTo}}"',
      '      - --reply-in-thread',
      '      - --msg-type',
      '      - interactive',
      '      - --content',
      '      - "{{card}}"',
      '    cardArgs:',
      `      - ${JSON.stringify(lark)}`,
      '      - im',
      '      - +messages-send',
      '      - --as',
      '      - bot',
      '      - --chat-id',
      '      - "{{chatId}}"',
      '      - --msg-type',
      '      - interactive',
      '      - --content',
      '      - "{{card}}"',
      '    patchCardArgs:',
      `      - ${JSON.stringify(lark)}`,
      '      - im',
      '      - messages',
      '      - patch',
      '      - --as',
      '      - bot',
      '      - --message-id',
      '      - "{{messageId}}"',
      '      - --data',
      '      - "{{data}}"',
      'classifiers:',
      '  llm:',
      '    plugin: classifier-llm',
      '    prompt: prompts/classify.md',
      '    minConfidence: 0.3',
      'executor_policies:',
      '  dsh:',
      '    plugin: executor-dsh',
      '    allowRoots: [' + JSON.stringify(wsRoot) + ']',
      '  claude:',
      '    plugin: executor-claude',
      `    allowRoots: [${JSON.stringify(wsRoot)}]`,
      `    binary: ${JSON.stringify(process.execPath)}`,
      '    args:',
      `      - ${JSON.stringify(claude)}`,
      '      - --bg',
      '      - --session-id',
      '      - "{{sessionId}}"',
      '      - "{{prompt}}"',
      '    defaultBudgetUsd: 1',
      `    sessionsDir: ${JSON.stringify(join(root, 'claude-sessions'))}`,
      'limits: { maxConcurrentSessions: 2, maxSessionMB: 80 }',
      '',
    ].join('\n'),
    'utf8',
  )

  const projectsYaml = opts.twoWorkspaces
    ? ['workspaces:',
       '  - id: demo', '    name: 演示', '    kind: repo', `    root: ${JSON.stringify(wsRoot)}`,
       '    executor: claude', '    isolation: session', '    concurrency: 1', '    freshSession: true',
       '    aliases: [demo]',
       '  - id: other', '    name: 另一个', '    kind: repo', `    root: ${JSON.stringify(join(wsRoot, 'b'))}`,
       '    executor: claude', '    isolation: session', '    concurrency: 1', '    freshSession: true',
       '    aliases: [other]', ''].join('\n')
    : ['workspaces:', '  - id: demo', '    name: 演示', '    kind: repo', `    root: ${JSON.stringify(wsRoot)}`,
       '    executor: claude', '    isolation: session', '    concurrency: 1', '    freshSession: true',
       '    aliases: [demo]', ''].join('\n')
  writeFileSync(
    join(root, 'config/projects.yaml'),
    projectsYaml,
    'utf8',
  )
  writeFileSync(join(root, 'prompts/classify.md'), '分类提示词占位', 'utf8')
  // 开窗档不需要规则：给一份空规则表（结构必须合法）
  writeFileSync(
    join(root, 'config/rules.yaml'),
    ['allowlist:', '  groups: []', '  people: []', '  keywords: []', 'rules: []', ''].join('\n'),
    'utf8',
  )
  writeFileSync(wsFile, JSON.stringify({ title: '修订单分页' }), 'utf8')

  return { root, calls }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(50)
  }
  throw new Error('等待超时')
}

test('端到端：群里说话 → 开窗 → 锚消息 → 状态卡 → 钩子回传', { timeout: 60_000 }, async () => {
  const { root, calls } = setup()
  const controller = new AbortController()
  const running = runRuntime({ root, tickMs: 50, signal: controller.signal })
  const readCalls = (): string[] =>
    existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []

  try {
    // 1) 事件进来 → 开窗（只有一个工作区，不问）
    await waitFor(() => readCalls().some((l) => l.includes('event')))
    await waitFor(() => readCalls().some((l) => l.includes('claude') && l.includes('--bg')))
    // 1b) 开窗后的第一条回复必须进用户那条话题（--reply-in-thread），
    //     不能用「发到群」——那样会另起一个话题，把用户的话题晾在一边
    await waitFor(() => readCalls().some((l) => l.includes('窗口已创建')))
    const anchor = readCalls().find((l) => l.includes('窗口已创建'))!
    assert.ok(anchor.includes('--reply-in-thread'), '开窗回复要进原话题')
    assert.ok(!anchor.includes('--chat-id'), '开窗回复不能再发到群（会另起话题）')

    // 2) 锚消息 + 状态卡（interactive）
    await waitFor(() => readCalls().some((l) => l.includes('interactive')))
    const cardSend = readCalls().find((l) => l.includes('interactive'))
    assert.ok(cardSend, '应当发过状态卡')

    // 3) 钩子：等端点起来后模拟 claude 的 Stop 回传
    await waitFor(() => readHookInfo(root) !== null)
    const info = readHookInfo(root)!
    const sid = readFileSync(join(root, 'short-id.txt'), 'utf8').trim()
    const res = await fetch(`http://127.0.0.1:${info.port}/stop?t=${info.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, last_assistant_message: '分页改好了' }),
    })
    assert.equal(res.status, 200)

    // 4) 结果回到话题：应当有一条非 interactive 的回复带着结果正文
    // 结果以「话题内回复」的形式回去（+messages-reply），不是重新发一条
    await waitFor(() => readCalls().some((l) => l.includes('+messages-reply') && l.includes('分页改好了')))
    assert.ok(
      readCalls().some((l) => l.includes('+messages-reply') && l.includes('分页改好了')),
      '结果应作为话题内回复回到原话题',
    )
  } finally {
    controller.abort()
    await running
  }
})

test('端到端：两个工作区 → 选择卡 → 点按钮 → 开窗 → 通知三行', { timeout: 90_000 }, async () => {
  const { root, calls } = setup({ twoWorkspaces: true })
  const controller = new AbortController()
  const running = runRuntime({ root, tickMs: 50, signal: controller.signal })
  const readCalls = (): string[] =>
    existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []

  try {
    // 1) 两个候选 → 不自动开窗，先弹选择卡
    await waitFor(() => readCalls().some((l) => l.includes('interactive') && l.includes('pick')))
    const pickerLine = readCalls().find((l) => l.includes('interactive') && l.includes('pick'))!
    const pickerArgs = JSON.parse(pickerLine) as string[]
    const cardJson = pickerArgs[pickerArgs.indexOf('--content') + 1]!
    const card = JSON.parse(cardJson) as { elements: { actions?: { value: { k: string; workspaceId: string; thread?: string; root?: string } }[] }[] }
    const buttons = card.elements.flatMap((e) => e.actions ?? [])
    assert.equal(buttons.length, 2, '两个工作区就该有两个按钮')
    assert.equal(buttons[0]!.value.k, 'pick', '按钮值要能被回调认出来')

    // 2) 模拟点第一个按钮（回调是独立订阅，载荷里没有 thread_id，话题信息靠按钮自己带）
    const click = buttons[0]!.value
    writeFileSync(
      join(root, 'card-action.json'),
      JSON.stringify({
        type: 'card.action.trigger',
        event_id: 'evt_click_1',
        operator_id: 'ou_1',
        message_id: 'om_picker',
        chat_id: 'oc_1',
        action_tag: 'button',
        action_value: JSON.stringify(click),
      }) + '\n',
      'utf8',
    )

    // 3) 选定后开窗：回复要进用户那条话题，不能另起话题
    await waitFor(() => readCalls().some((l) => l.includes('窗口已创建')))
    const anchor = readCalls().find((l) => l.includes('窗口已创建'))!
    assert.ok(anchor.includes('--reply-in-thread'), '开窗回复要进原话题')
    assert.ok(!anchor.includes('--chat-id'), '开窗回复不能发到群（会另起话题）')

    // 4) 钩子回传：通知带 📁/🕐 头
    await waitFor(() => readHookInfo(root) !== null)
    const info = readHookInfo(root)!
    const sid = readFileSync(join(root, 'short-id.txt'), 'utf8').trim()
    const res = await fetch(`http://127.0.0.1:${info.port}/stop?t=${info.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, last_assistant_message: '分页改好了' }),
    })
    assert.equal(res.status, 200)
    await waitFor(() => readCalls().some((l) => l.includes('📁') && l.includes('分页改好了')))
    const notify = readCalls().find((l) => l.includes('📁') && l.includes('分页改好了'))!
    assert.ok(notify.includes('🕐'), '通知要有时间那一行')
  } finally {
    controller.abort()
    await running
  }
})
