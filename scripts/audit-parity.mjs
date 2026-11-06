#!/usr/bin/env node
/**
 * 对齐表自审：把 docs/005 第 5 节里「已实现」的每一条，落到代码里的具体符号，
 * 逐条核对它真的存在（防止自己给自己记账）。只读，不改任何东西。
 *
 * 用法：node scripts/audit-parity.mjs
 */

import { readFileSync } from 'node:fs'

/** 每条：编号、名字、落点符号（`文件:符号`；只写文件表示「文件存在即可」） */
const ROWS = [
  [1, '话题路由', ['src/kernel/pipeline.ts:sessionByMessage', 'src/kernel/pipeline.ts:recentSession']],
  [2, '引用回复路由', ['src/kernel/store.ts:mapMessage', 'src/kernel/store.ts:sessionByMessage']],
  [3, '单聊回退', ['src/kernel/store.ts:recentSession', 'src/kernel/pipeline.ts:P2P_RECENT_MS']],
  [4, '从飞书新开窗口', ['src/kernel/pipeline.ts:#openFlow']],
  [5, '工作区卡', ['src/plugins/channel-feishu/card.ts:renderPickerCard', 'src/kernel/pipeline.ts:pickMax']],
  [6, '#目录名/#别名', ['src/kernel/pipeline.ts:includes(needle)']],
  [7, '命令别名与序号', ['src/routing/commands.ts:newwin', 'src/kernel/pipeline.ts:#answerPendingWorkspace']],
[8, '恢复历史会话', ['src/plugin-kit/claude-discover.ts:discoverSessions', 'src/kernel/pipeline.ts:resumeMax']],
  [9, '换会话', ['src/kernel/store.ts:rebindSession', 'src/kernel/pipeline.ts:rebindSessionId']],
  [10, '再开一个窗口', ['src/kernel/pipeline.ts:#startNewWindowFlow', 'src/kernel/pipeline.ts:fresh']],
  [11, '新话题置顶', ['src/plugins/channel-feishu/index.ts:pinCards']],
  [12, '置顶对账', ['src/kernel/pipeline.ts:reconcilePins', 'src/kernel/store.ts:cardPinnedAge']],
  [13, '答选择题', ['src/kernel/questions.ts:buildHookDecision', 'src/kernel/pipeline.ts:#answerByCard']],
  [14, '交还终端/失效点击', ['src/kernel/pipeline.ts:#handBackByCard', 'src/plugins/channel-feishu/card.ts:renderQuestionCard']],
  [15, '在场探测', ['src/kernel/presence.ts:isPresent']],
  [16, '权限确认', ['src/kernel/questions.ts:buildPermissionDecision']],
  [17, '任务完成通知', ['src/kernel/hook-handlers.ts:formatStopMessage', 'src/kernel/hook-handlers.ts:splitChunks']],
  [18, '通知带终端输入', ['src/kernel/transcript.ts:lastUserInput']],
  [19, '提醒卡分类去重', ['src/kernel/hook-handlers.ts:notifyKind', 'src/kernel/hook-handlers.ts:NOTIFY_TITLE']],
  [20, '提醒卡 @', ['src/kernel/hook-handlers.ts:ownerId']],
  [21, '实时状态卡', ['src/kernel/card-content.ts:buildStatusCard', 'src/kernel/transcript.ts:currentTurn']],
  [22, '状态卡换卡', ['src/kernel/pipeline.ts:cardTurn', 'src/kernel/pipeline.ts:card_patch']],
  [23, '自动回复策略', ['src/routing/auto-reply.ts:decideAutoReply', 'src/routing/auto-reply.ts:policyProblem']],
  [24, '自动回复投递', ['src/kernel/pipeline.ts:autoReplyTick', 'src/kernel/store.ts:canAutoReply']],
  [25, '图片转发与清理', ['src/kernel/pipeline.ts:downloadImage', 'src/kernel/cleanup.ts:cleanupImages']],
  [26, '网页改配置', ['src/kernel/config-schema.ts:describeConfig', 'src/desktop/server.ts:ConfigField']],
  [27, '开机自启+看门狗', ['scripts/supervise.mjs:backoffMs', 'scripts/install-autostart.mjs']],
  [30, '会话开场约定', ['src/kernel/hook-handlers.ts:onSessionStart', 'src/kernel/hook-server.ts:/session-start']],
  [31, '过期数据清理', ['src/kernel/cleanup.ts:runCleanup', 'src/kernel/store.ts:pruneMessageMap']],
[32, '错误兜底', ['src/plugin-kit/restart.ts:restartDelay', 'src/plugin-kit/restart.ts:explainExit']],
]

/**
 * 第二轮审计补的「实现层约定」：不是新功能，而是做法细节（阈值、文案、顺序）。
 * 每条都给代码落点，防止文档写了、代码后来又被改回去。
 */
const CONVENTIONS = [
  // 用**字面量**核：常量改名不算破坏，标记文本变了才算（那才是行为变了）
  [1, '投递信封', ['src/kernel/envelope.ts:[来自用户本人 · 飞书]', 'src/kernel/envelope.ts:[来自用户本人 · 自动回复]', 'src/kernel/pipeline.ts:withEnvelope']],
  [2, '等作答 30 分钟+探在场', ['src/kernel/questions.ts:waitForAnswer', 'src/kernel/runtime.ts:PRESENCE_PROBE_MS']],
  [3, '分段 4000+1 秒', ['src/kernel/hook-handlers.ts:splitChunks', 'src/kernel/store.ts:not_before']],
  [4, '通知卡片三行独立', ['src/kernel/notice-card.ts:buildNoticeCard', 'src/plugins/channel-feishu/card.ts:renderNoticeCard']],
  [5, '终端输入两档', ['src/kernel/notice-card.ts:SAID_INLINE_MAX', 'src/kernel/notice-card.ts:SAID_FULL_MAX']],
  [6, '题卡状态机', ['src/kernel/pipeline.ts:#settleQuestionCard', 'src/kernel/store.ts:questionCard']],
  [7, '权限卡四按钮', ['src/kernel/questions.ts:buildPermissionCard', 'src/kernel/pipeline.ts:#answerPermissionByCard']],
  [8, '换卡撤旧置顶', ['src/kernel/pipeline.ts:pinMessage(old.messageId, false)']],
  [9, '改卡失败换新卡', ['src/kernel/pipeline.ts:store.dropCard(session.id)']],
  [10, '子任务黄灯', ['src/kernel/transcript.ts:openSubtasks', 'src/kernel/card-content.ts:🟡 本轮已回复']],
  [11, '就绪卡', ['src/plugins/channel-feishu/card.ts:renderReadyCard']],
  [12, '在场阈值 180 秒', ['src/kernel/presence.ts:AWAY_IDLE_MS = 180_000']],
  [13, '候选上限 pickMax', ['src/kernel/pipeline.ts:pickMax ?? 20']],
  [14, '命令前缀匹配', ['src/routing/commands.ts:parseAbsolutePathCommand', "src/routing/commands.ts:'#继续'"]],
  [15, '图片日期目录+用量 floor', ['src/kernel/images.ts:imageDayDir', 'src/kernel/transcript.ts:Math.floor(ratio * cells)']],
]

/** 测试里出现这些词，说明这一条至少被某条测试碰过。 */
const TEST_HINTS = {
  1: ['sessionByMessage', 'recentSession'],
  2: ['mapMessage', '引用'],
  3: ['recentSession', '单聊'],
  4: ['开窗'],
  5: ['renderPickerCard', 'pickMax', '选择卡'],
  6: ['模糊'],
  7: ['newwin', '命令解析'],
  8: ['discoverSessions', 'resumeMax', '恢复'],
  9: ['rebindSession', '换会话'],
  10: ['#新窗'],
  11: ['pinCards', '置顶'],
  12: ['reconcilePins', '置顶对账'],
  13: ['answerByCard', '选择题卡片', 'buildHookDecision'],
  14: ['handBackByCard', '交还终端'],
  15: ['isPresent', 'presence'],
  16: ['buildPermissionDecision', '权限'],
  17: ['formatStopMessage', 'splitChunks', '分段'],
  18: ['lastUserInput', '终端里说'],
  19: ['notifyKind', '提醒卡'],
  20: ['ownerId', '@'],
  21: ['buildStatusCard', '状态卡'],
  22: ['cardTurn', '换卡'],
  23: ['decideAutoReply', '自动回复'],
  24: ['autoReplyTick', '自动回复'],
  25: ['cleanupImages', '图片'],
  26: ['describeConfig', '配置页'],
  27: ['backoffMs', '看门狗'],
  30: ['onSessionStart', '约定'],
  31: ['runCleanup', 'pruneQuestions'],
  32: ['restartDelay', '退避'],
}

/**
 * 落点检查用的是**子串**语义：`文件:符号` 只需要在这个文件里出现。
 * 够用，因为它防的是「表里写着已实现、代码里根本没有这一坨」；
 * 不防「改名成前缀更长的名字」——那种情况看 diff 更靠得住。
 */
function declares(body, symbol) {
  return body.includes(symbol)
}

const testBlob = (await import('node:fs'))
  .readdirSync('test')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => readFileSync(`test/${f}`, 'utf8'))
  .join('\n')

let missingTotal = 0
const untested = []
for (const [id, name, refs] of ROWS) {
  const missing = []
  for (const ref of refs) {
    const idx = ref.indexOf(':')
    const file = idx === -1 ? ref : ref.slice(0, idx)
    const symbol = idx === -1 ? null : ref.slice(idx + 1)
    let body
    try {
      body = readFileSync(file, 'utf8')
    } catch {
      missing.push(`${ref}（文件不存在）`)
      continue
    }
    if (symbol && !declares(body, symbol)) missing.push(ref)
  }
  if (missing.length) {
    missingTotal++
    console.log(`✖ #${id} ${name}：落点缺失 ${missing.join(' / ')}`)
  }
  const hints = TEST_HINTS[id] ?? [name]
  if (!hints.some((h) => testBlob.includes(h))) untested.push(`#${id} ${name}`)
}

// 实现层约定：同样核落点（文档 §5.1b 那张表）
let convMissing = 0
for (const [id, name, refs] of CONVENTIONS) {
  const missing = []
  for (const ref of refs) {
    const idx = ref.indexOf(':')
    const file = idx === -1 ? ref : ref.slice(0, idx)
    const symbol = idx === -1 ? null : ref.slice(idx + 1)
    let body
    try {
      body = readFileSync(file, 'utf8')
    } catch {
      missing.push(`${ref}（文件不存在）`)
      continue
    }
    if (symbol && !body.includes(symbol)) missing.push(ref)
  }
  if (missing.length) {
    convMissing++
    console.log(`✖ C${id} ${name}：落点缺失 ${missing.join(' / ')}`)
  }
}

console.log(`\n落点核对：${ROWS.length} 条功能 + ${CONVENTIONS.length} 条实现约定`)
console.log(`  功能缺失 ${missingTotal} 条 / 约定缺失 ${convMissing} 条`)
console.log(`测试踪迹：${ROWS.length - untested.length}/${ROWS.length}`)
if (untested.length) console.log(`  未在测试里出现：${untested.join('、')}`)
process.exitCode = missingTotal + convMissing ? 1 : 0
