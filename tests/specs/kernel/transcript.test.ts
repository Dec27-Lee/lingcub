import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  contextBar,
  findTranscript,
  formatTokens,
  lastUserInput,
  statsLine,
  transcriptStats,
  unwrapPasted,
} from '../../../src/kernel/transcript.ts'
import { formatStopMessage } from '../../../src/kernel/hook-handlers.ts'

function tmp(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-tr-'))
  const f = join(dir, name)
  writeFileSync(f, body, 'utf8')
  return f
}

const userLine = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'

test('反查人话：跳过系统产物与工具回执，取最后一条真正的输入', () => {
  // 顺序很重要：把「系统产物 / 工具回执」放在最后，
  // 才能证明它们真的被跳过（而不是因为它是最后一条才碰巧返回）
  const f = tmp(
    's.jsonl',
    userLine('再改一版') +
      userLine('<local-command-caveat>caveat</local-command-caveat>') +
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }) +
      '\n' +
      userLine('<task-notification>done</task-notification>'),
  )
  assert.equal(lastUserInput(f), '再改一版', '尾部三条都是系统产物，要往前找到真正的人话')
})

test('反查人话：这一轮是飞书发起的就直接返回 null，不能往前翻到旧的终端输入', () => {
  const f = tmp('s.jsonl', userLine('很早以前在终端说的话') + userLine('【来自飞书】把它改成分页'))
  assert.equal(lastUserInput(f), null)
})

test('剥包装：粘贴块与贴图占位符去掉，人写的内容保留', () => {
  assert.equal(unwrapPasted('<pasted_content>看这段代码</pasted_content>'), '看这段代码')
  assert.equal(unwrapPasted('说明 [Image #1] 结尾'), '说明\n结尾')
})

test('用量：从最后一次 usage 累加 input 与两种 cache；没有 usage 返回 null', () => {
  const f = tmp(
    's.jsonl',
    JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 } },
    }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 200 } },
      }) +
      '\n',
  )
  const s = transcriptStats(f)!
  assert.equal(s.used, 250, '最后一次 = 50 + 200')
  assert.equal(s.total, 180, '累计 = 120 + 60')

  const empty = tmp('e.jsonl', '{"type":"user"}\n')
  assert.equal(transcriptStats(empty), null)
})

test('用量那一行：有进度条与百分比；取不到就空串', () => {
  assert.equal(formatTokens(108_000), '108k')
  assert.equal(formatTokens(1_200_000, 1), '1.2M')
  assert.match(contextBar(50_000, 100_000), /^█{2}░{2} 50%$/, '4 格：50% = 两格')
  const f = tmp(
    's.jsonl',
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 50_000, output_tokens: 5 } } }) + '\n',
  )
  const line = statsLine(f, 100_000)
  assert.match(line, /^█{2}░{2} 50% 50k · Tokens /)
  assert.equal(statsLine(undefined, 100_000), '')
})

test('找到转录文件：给会话 id 就能在 projects 下命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-proj-'))
  const slug = join(dir, '-slug-')
  mkdirSync(slug, { recursive: true })
  writeFileSync(join(slug, 'abc-123.jsonl'), userLine('hi'))
  assert.ok(findTranscript('abc-123', dir)?.endsWith('abc-123.jsonl'))
  assert.equal(findTranscript('nope', dir), undefined)
})

test('通知正文：目录/时间/分隔线/正文，飞书发起的不带「你在终端说」', () => {
  const f = tmp('s.jsonl', userLine('【来自飞书】改一下分页'))
  const text = formatStopMessage({
    payload: { session_id: 's', last_assistant_message: '分页改好了' },
    workspace: 'E:\\Develop_E\\lingcub',
    transcript: f,
    at: new Date('2026-11-03T12:00:00Z'),
  })
  assert.match(text, /^📁 `E:\\Develop_E\\lingcub`/)
  assert.match(text, /🕐 /)
  assert.ok(!text.includes('💬'), '飞书发起的这轮不该回显终端输入')
  assert.ok(text.endsWith('——\n分页改好了'))
})

test('通知正文：终端里说的话会带出来（长句截断）', () => {
  const long = '很长的一句话'.repeat(40)
  const f = tmp('s.jsonl', userLine(long))
  const text = formatStopMessage({
    payload: { session_id: 's', last_assistant_message: '好' },
    transcript: f,
  })
  assert.match(text, /💬 你在终端说：/)
  assert.match(text, /…/)
})

test('状态卡内容：有转录时画完整几行（在跑时长/改了几个文件/它说/用量）', async () => {
  const { buildStatusCard } = await import('../../../src/kernel/card-content.ts')
  const f = tmp(
    's.jsonl',
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date(Date.now() - 90_000).toISOString(), message: { content: '把导出按钮加上' } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'E:\\x\\a.ts' } }] } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'E:\\x\\a.ts' } }] } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'E:\\x\\b.ts' } }], usage: { input_tokens: 10_000, output_tokens: 5 } } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '导出按钮加好了' }] } }) +
      '\n',
  )
  const session = {
    id: 'sess-1',
    chatId: 'oc_1',
    title: '修订单分页',
    executor: 'claude' as const,
    workspace: 'E:\\Develop_E\\lingcub',
    sessionId: 'sid-1',
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  }
  const card = buildStatusCard({ session, transcript: f, running: true, contextWindow: 200_000 })
  const text = card.lines.join('\n')
  assert.equal(card.status, 'running')
  assert.match(text, /💬 你说：把导出按钮加上/)   // 终端里这句要出现在最上面
  assert.match(text, /🟢 正在运行 · 已 1:30/)       // 90 秒
  assert.match(text, /✏️ 本轮改了 2 个文件/)        // a.ts 出现两次只算一个
  assert.match(text, /🤖 它说：导出按钮加好了/)
  assert.match(text, /📁 `E:\\Develop_E\\lingcub`/)
  assert.match(text, /📦 /)
})

test('状态卡内容：在跑的时候多一行「正在用哪个工具」', async () => {
  const { buildStatusCard } = await import('../../../src/kernel/card-content.ts')
  const f = tmp(
    's.jsonl',
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { content: '跑一下测试' } }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
      }) +
      '\n',
  )
  const session = {
    id: 'sess-t',
    chatId: 'oc_1',
    title: '跑测试',
    executor: 'claude' as const,
    workspace: 'E:\\w',
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  }
  const running = buildStatusCard({ session, transcript: f, running: true })
  assert.match(running.lines.join('\n'), /🔧 `Bash`：pnpm test/)

  // 没有工具调用就是在生成：显示「正在思考」
  const f2 = tmp(
    's2.jsonl',
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { content: '说说思路' } }) + '\n',
  )
  const thinking = buildStatusCard({ session, transcript: f2, running: true })
  assert.match(thinking.lines.join('\n'), /🤔 正在思考/)

  // 已经停了就不该再显示「正在用工具」
  const done = buildStatusCard({ session, transcript: f, running: false })
  const text = done.lines.join('\n')
  assert.ok(!text.includes('🔧'), '停下的卡不该说它在用工具')
  assert.ok(!text.includes('🤔'), '停下的卡不该说它在思考')
})

test('状态卡内容：没有转录也能画（只有目录与结束时间），不编数', async () => {
  const { buildStatusCard } = await import('../../../src/kernel/card-content.ts')
  const session = {
    id: 'sess-2',
    chatId: 'oc_1',
    executor: 'claude' as const,
    workspace: 'E:\\w',
    status: 'stopped' as const,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date(Date.now() - 120_000).toISOString(),
  }
  const card = buildStatusCard({ session, running: false })
  assert.equal(card.status, 'done')
  assert.match(card.lines.join('\n'), /⚪ 本轮结束 · 2 分钟前/)
  assert.ok(!card.lines.join('\n').includes('📦'), '没有转录就不画用量')
})

test('子任务：未闭合的 Agent / 后台 Bash 算「还在跑」，有 tool_result 就不算', async () => {
  const { currentTurn, describeSubtask } = await import('../../../src/kernel/transcript.ts')

  // 描述规则：Agent/Task 与 run_in_background 的 Bash 才是子任务
  assert.deepEqual(describeSubtask('Agent', { subagent_type: 'Explore', description: '找一下缓存实现' }), {
    name: 'Explore',
    what: '找一下缓存实现',
  })
  assert.deepEqual(describeSubtask('Bash', { run_in_background: true, command: 'pnpm dev' }), {
    name: 'Bash',
    what: 'pnpm dev',
  })
  assert.equal(describeSubtask('Bash', { command: 'ls' }), null, '前台 Bash 不是子任务')
  assert.equal(describeSubtask('Read', { file_path: 'a.ts' }), null)

  const started = new Date().toISOString()
  const rows = [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: started, message: { content: '跑测试并起个服务' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Agent', input: { subagent_type: 'Explore', description: '找缓存' } },
          { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { run_in_background: true, command: 'pnpm dev' } },
          { type: 'tool_use', id: 'tu-3', name: 'Agent', input: { subagent_type: 'Plan', description: '已经跑完的' } },
        ],
      },
    }),
    // tu-3 已经回来了；tu-1 / tu-2 没有
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-3', content: 'ok' }] } }),
  ].join('\n')
  const file = tmp('turn-sub.jsonl', rows + '\n')
  const turn = currentTurn(file)
  assert.deepEqual(
    turn.openSubtasks?.map((s) => `${s.name}:${s.what}`),
    ['Explore:找缓存', 'Bash:pnpm dev'],
    '只留没闭合的',
  )
})

test('状态卡：主会话说完了但子任务还在跑 → 黄灯，不说「本轮结束」', async () => {
  const { buildStatusCard } = await import('../../../src/kernel/card-content.ts')
  const started = new Date().toISOString()
  const file = tmp(
    'card-sub.jsonl',
    [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: started, message: { content: '跑起来' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Agent', input: { subagent_type: 'Explore', description: '找缓存' } }] },
      }),
    ].join('\n') + '\n',
  )
  const session = {
    id: 's',
    chatId: 'oc_1',
    title: '跑起来',
    executor: 'claude' as const,
    workspace: 'E:\\w',
    status: 'active' as const,
    createdAt: started,
    lastActiveAt: started,
  }
  const done = buildStatusCard({ session, transcript: file, running: false })
  const text = done.lines.join('\n')
  assert.match(text, /🟡 本轮已回复，1 个子任务还在跑/)
  assert.match(text, /🤖 `Explore`：找缓存/)
  assert.ok(!text.includes('⚪ 本轮结束'), '有子任务在跑就不能说本轮结束')

  // 在跑的时候也提一句
  const running = buildStatusCard({ session, transcript: file, running: true })
  assert.match(running.lines.join('\n'), /另有 1 个子任务在跑/)
})

test('用量进度条：4 格、floor 填充（96% 不能画成满格）、百分数 round', async () => {
  const { contextBar } = await import('../../../src/kernel/transcript.ts')
  assert.equal(contextBar(0, 200_000), '░░░░ 0%')
  assert.equal(contextBar(50_000, 200_000), '█░░░ 25%')
  // 96%：floor → 3 格（写 round 的话会满格，看着像已经爆了）
  assert.equal(contextBar(192_000, 200_000), '███░ 96%')
  // 只有在真的到顶时才满格
  assert.equal(contextBar(200_000, 200_000), '████ 100%')
  assert.equal(contextBar(250_000, 200_000), '████ 100%', '超过也算满')
  assert.equal(contextBar(1000, 0), '', '没有分母就不画')
})

test('用量统计：转录没变时命中缓存，改了才重扫', async () => {
  const { transcriptStats } = await import('../../../src/kernel/transcript.ts')
  const file = tmp('usage.jsonl', JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n')
  const a = transcriptStats(file)
  assert.deepEqual(a, { used: 100, total: 150 })
  // 同一份内容再读一次：结果一样（走缓存）
  assert.deepEqual(transcriptStats(file), a)
  // 追加一行后必须重算，不能拿旧数
  const fs = await import('node:fs')
  fs.appendFileSync(file, JSON.stringify({ message: { usage: { input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 10 } } }) + '\n')
  const b = transcriptStats(file)
  assert.equal(b?.used, 500, '最后一次请求是 input+cache_read')
  assert.equal(b?.total, 150 + 210, '累计 tokens 也要更新')
})

test('会话真名：优先 claude 自己的 aiTitle，多次出现取最后一次；没有返回 undefined', async () => {
  const { transcriptTitle } = await import('../../../src/kernel/transcript.ts')
  const a = tmp('t1.jsonl', JSON.stringify({ type: 'assistant', aiTitle: '修订单分页' }) + '\n')
  assert.equal(transcriptTitle(a), '修订单分页')

  // 同一个键出现多次：以最后一次为准（标题会随对话演进）
  const b = tmp(
    't2.jsonl',
    [JSON.stringify({ aiTitle: '旧名字' }), JSON.stringify({ aiTitle: '新名字' })].join('\n') + '\n',
  )
  assert.equal(transcriptTitle(b), '新名字')

  // /rename 写的 customTitle 优先于 aiTitle
  const c = tmp(
    't3.jsonl',
    [JSON.stringify({ aiTitle: 'AI 起的' }), JSON.stringify({ customTitle: '我自己起的' })].join('\n') + '\n',
  )
  assert.equal(transcriptTitle(c), '我自己起的')

  const d = tmp('t4.jsonl', JSON.stringify({ type: 'user', message: { content: '还没起名字' } }) + '\n')
  assert.equal(transcriptTitle(d), undefined)
})
