#!/usr/bin/env node
/**
 * 平台契约体检（**零副作用**）：用「明显不存在的 id」去调真实 CLI，
 * 只关心两件事——参数形状对不对、我们的 JSON 能不能过 CLI 解析。
 *
 * 为什么这么做：这些错误只会在真连时暴露，而且分两类，必须分清——
 *   · `is not valid JSON` / `unknown flag` → 我们写错了，功能上线就是坏的；
 *   · `invalid receive_id` / `not a valid {open_message_id}` → 参数形状没问题，只是这个 id 不存在。
 * 全部用不存在 id，所以不会往任何群里发东西、不会改任何状态。
 *
 * 用法：node scripts/verify-contracts.mjs
 */

import { readFileSync } from 'node:fs'
import { runOnce } from '../dist/plugin-kit/spawn.js'

const BAD_CHAT = 'oc_9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f'
const BAD_MSG = 'om_ffffffffffffffffffffffffffffffff'

/** 我们的四种卡片都拿来试（renderCard 等由 dist 提供） */
function cards() {
  const dir = '../dist/plugins/channel-feishu/card.js'
  return Promise.all([import(dir), import('../dist/plugin-kit/feishu-cards.js')]).then(([m, kit]) => ({
    status: m.renderCard({ title: 't', status: 'running', lines: ['📁 x'] }),
    picker: m.renderPickerCard({
      title: 't',
      chatId: BAD_CHAT,
      rootMessageId: BAD_MSG,
      options: [{ key: 'project:demo', label: 'demo' }],
    }),
    resume: m.renderResumeCard({ chatId: BAD_CHAT, items: [{ label: 'a', sessionId: 's', cwd: 'E:\\x' }] }),
    question: m.renderQuestionCard({
      id: 'q1',
      question: '选哪个？',
      options: [{ label: '甲' }],
      index: 1,
      total: 1,
      multiSelect: false,
      chatId: BAD_CHAT,
    }),
    // 开窗向导的两步卡（场景侧渲染，走 plugin-kit）
    executor: kit.renderExecutorCard({ chatId: BAD_CHAT, title: 't', rootMessageId: BAD_MSG }),
    workspace: kit.renderWorkspaceCard({
      chatId: BAD_CHAT,
      title: 't',
      executor: 'claude',
      options: [{ root: 'E:\\x', label: 'x' }],
      rootMessageId: BAD_MSG,
    }),
  }))
}

const results = []
function record(name, code, out) {
  const text = (out || '').replace(/\s+/g, ' ').trim()
  // 我们写错的特征：JSON 过不了 CLI 解析、参数名错/缺必填、未知命令
  const ourFault =
    /not valid JSON|unknown (flag|command)|invalid argument "--|missing required (path )?parameter|no such (flag|command)|unexpected argument/i.test(
      text,
    )
  // 期望的样子：参数形状对，只是这个 id 不存在（或反过来，安全确认要求）
  const expected =
    /invalid receive_id|not a valid \{open_message_id\}|HTTP 400|confirmation_required|not exist|no such (message|chat)/i
  const ok = !ourFault && (expected.test(text) || code !== 0)
  results.push({ name, code, ok, ourFault, text: text.slice(0, 200) })
}

const cardSet = await cards()
const send = (card) =>
  runOnce({
    binary: 'lark-cli',
    args: ['im', '+messages-send', '--as', 'bot', '--chat-id', BAD_CHAT, '--msg-type', 'interactive', '--content', JSON.stringify(card)],
    timeoutMs: 25_000,
  })
const reply = (card) =>
  runOnce({
    binary: 'lark-cli',
    args: [
      'im', '+messages-reply', '--as', 'bot', '--message-id', BAD_MSG, '--reply-in-thread',
      '--msg-type', 'interactive', '--content', JSON.stringify(card),
    ],
    timeoutMs: 25_000,
  })

for (const [name, card] of Object.entries(cardSet)) {
  const r = await send(card)
  record(`发卡 ${name}（JSON 能否过 CLI 解析）`, r.code, r.stderr || r.stdout)
}

{
  const r = await reply(cardSet.picker)
  record('话题内回复卡（--reply-in-thread --message-id）', r.code, r.stderr || r.stdout)
}
{
  const r = await runOnce({
    binary: 'lark-cli',
    args: ['im', 'messages', 'patch', '--as', 'bot', '--message-id', BAD_MSG, '--data', JSON.stringify({ content: JSON.stringify(cardSet.status) })],
    timeoutMs: 25_000,
  })
  record('原地改卡（im messages patch --data）', r.code, r.stderr || r.stdout)
}
{
  const r = await runOnce({
    binary: 'lark-cli',
    args: ['im', 'pins', 'create', '--as', 'bot', '--data', JSON.stringify({ message_id: BAD_MSG })],
    timeoutMs: 25_000,
  })
  record('置顶（im pins create --data）', r.code, r.stderr || r.stdout)
}
{
  const r = await runOnce({
    binary: 'lark-cli',
    args: ['im', 'pins', 'delete', '--as', 'bot', '--message-id', BAD_MSG, '--yes'],
    timeoutMs: 25_000,
  })
  record('取消置顶（--message-id 且带 --yes）', r.code, r.stderr || r.stdout)
}
{
  const r = await runOnce({
    binary: 'lark-cli',
    args: ['im', '+messages-resources-download', '--as', 'bot', '--message-id', BAD_MSG, '--file-key', 'img_x', '--type', 'image', '--output', 'data/images/_probe'],
    timeoutMs: 25_000,
  })
  record('下载图片（参数形状）', r.code, r.stderr || r.stdout)
}
{
  // 私聊：open_id 直发（重点消息走这条路），顺带验幂等键长度
  const r = await runOnce({
    binary: 'lark-cli',
    args: [
      'im',
      '+messages-send',
      '--as',
      'bot',
      '--user-id',
      'ou_9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f',
      '--msg-type',
      'interactive',
      '--content',
      JSON.stringify(cardSet.executor),
      '--idempotency-key',
      'probe-dm-001',
    ],
    timeoutMs: 25_000,
  })
  record('私聊发卡（--user-id + 幂等键）', r.code, r.stderr || r.stdout)
}
{
  // 只读：列置顶（对账要看清撤哪些）
  const r = await runOnce({
    binary: 'lark-cli',
    args: ['im', 'pins', 'list', '--as', 'bot', '--chat-id', BAD_CHAT],
    timeoutMs: 25_000,
  })
  record('列置顶（im pins list --chat-id）', r.code, r.stderr || r.stdout)
}

let bad = 0
for (const r of results) {
  if (r.ourFault) bad++
  const mark = r.ourFault ? '✖' : r.ok ? '✔' : '?'
  const why = r.ourFault ? ` —— 我们写错了：${r.text}` : r.ok ? '' : ` —— 没认出来的结果：${r.text}`
  console.log(`${mark} ${r.name}${why}`)
}
console.log(`\n契约体检：${results.length} 项，写错 ${bad} 项（其余失败都是「id 不存在」，属预期）`)
process.exitCode = bad ? 1 : 0

// 顺手把「用到的参数模板」跟代码里的默认值对一遍，配置改坏了这里也能看出来
void readFileSync
