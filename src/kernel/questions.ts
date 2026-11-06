/**
 * 选择题：把 claude 的 AskUserQuestion 搬到话题里答。
 *
 * 协议来自 Claude Code 的 PreToolUse 钩子（生产实现已验证）：
 *   返回 `{ permissionDecision: 'allow', updatedInput: { questions, answers } }`
 * 就能跳过终端弹窗，answers 当作「用户作答」直接交给模型。
 * `answers` 的 key 必须与 `questions[].question` 原文一致。
 *
 * 拿不到答案时**什么都不返回**（钩子 exit 0），终端弹窗照常出现——
 * 宁可让人在电脑前答，也不要代答成空气。
 */

import type { PendingQuestion } from './store.ts'

export interface QuestionOption {
  label: string
  description?: string
}

/** 把话题里的一句回复解析成「这一题的答案」；认不出返回 null。 */
export function pickAnswer(
  q: PendingQuestion,
  text: string,
): { question: string; answer: string } | null {
  const target = q.questions.find((x) => q.answers[x.question] === undefined)
  if (!target) return null
  const raw = text.trim()
  if (!raw) return null

  const options = target.options ?? []
  const numbered = raw.split(/[,，\s]+/).filter(Boolean)
  const picks = numbered
    .map((tok) => {
      const n = Number(tok.replace(/^#/, ''))
      return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1]?.label : undefined
    })
    .filter((x): x is string => Boolean(x))

  if (picks.length) {
    // 多选题才允许一次选多个；单选题只认第一个，避免误合并
    return { question: target.question, answer: target.multiSelect ? picks.join(', ') : picks[0]! }
  }

  // 不是序号：当作自由作答（claude 的选项里有「其他」时就是这么用的）
  const byLabel = options.find((o) => o.label === raw)
  if (byLabel) return { question: target.question, answer: byLabel.label }
  return { question: target.question, answer: raw }
}

/** 选择题卡片的数据（渲染成飞书卡片由频道插件负责）。 */
export function buildQuestionCard(id: string, q: PendingQuestion | null, session: { chatId: string; threadId?: string; rootMessageId?: string }): unknown {
  const target = q?.questions.find((x) => q.answers[x.question] === undefined) ?? q?.questions[0]
  const idx = target && q ? q.questions.indexOf(target) + 1 : 1
  return {
    kind: 'question',
    id,
    header: target?.header,
    question: target?.question ?? '（有一道题要你答）',
    options: target?.options ?? [],
    index: idx,
    total: q?.questions.length ?? 1,
    multiSelect: Boolean(target?.multiSelect),
    chatId: session.chatId,
    threadId: session.threadId,
    rootMessageId: session.rootMessageId,
  }
}

/** 把题目渲染成话题里的一段文字。 */
export function renderQuestion(q: PendingQuestion): string {
  const target = q.questions.find((x) => q.answers[x.question] === undefined) ?? q.questions[0]
  if (!target) return '（没有题目）'
  const idx = q.questions.indexOf(target) + 1
  const total = q.questions.length
  const head = `❓ ${target.header ? `${target.header}：` : ''}${target.question}`
  const opts = (target.options ?? []).map((o, i) => `${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}`)
  const tail = opts.length ? `\n回序号作答${total > 1 ? `（第 ${idx}/${total} 题）` : ''}${target.multiSelect ? '，多选用逗号' : ''}；也可以直接回文字` : '\n直接回文字作答'
  return head + (opts.length ? `\n${opts.join('\n')}` : '') + tail
}

/** 钩子该返回的内容；没有答案就返回空对象（让终端弹窗照常出现）。 */
export function buildHookDecision(q: PendingQuestion): Record<string, unknown> {
  const answered = q.questions.filter((x) => q.answers[x.question] !== undefined)
  if (!answered.length) return {}
  return {
    permissionDecision: 'allow',
    updatedInput: { questions: q.questions, answers: q.answers },
  }
}

// ---- 工具授权（PermissionRequest）----

export interface PermissionInput {
  tool_name?: string
  tool_input?: unknown
  permission_suggestions?: unknown
}

/**
 * 文字作答只认**整行**的 1 / 2（可带「总是」）。
 * 参考项目同样不吃自由文字：随手打一句「允许」到底是在回答授权，还是在下别的指令，
 * 机器分不清；按钮才是主通道。
 */
export function pickPermissionAnswer(text: string): { behavior: 'allow' | 'deny'; always?: boolean } | null {
  const raw = text.trim().toLowerCase()
  if (!raw) return null
  const always = /总是|以后都/.test(raw)
  const core = raw.replace(/总是|以后都/g, '').trim()
  if (core === '1') return { behavior: 'allow', ...(always ? { always: true } : {}) }
  if (core === '2') return { behavior: 'deny' }
  return null
}

/** 把工具授权渲染成话题里的一句话。 */
export function renderPermission(p: PermissionInput): string {
  const tool = p.tool_name ?? '未知工具'
  const detail = summarizeToolInput(p.tool_input)
  return `🔐 要用工具 ${tool}${detail ? `：${detail}` : ''}\n回 1 允许 / 2 拒绝；回「1 总是」= 本会话不再问`
}

function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return truncate(input, 160)
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
      const v = o[key]
      if (typeof v === 'string' && v) return truncate(`${key}=${v}`, 160)
    }
  }
  return ''
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 授权钩子该输出的 JSON；没答案返回空对象（终端弹窗照常出现）。 */
export function buildPermissionDecision(
  answers: Record<string, string>,
  toolInput: unknown,
  toolName = '*',
): Record<string, unknown> {
  const behavior = answers['decision']
  if (behavior !== 'allow' && behavior !== 'deny') return {}
  const decision: Record<string, unknown> = { behavior }
  if (behavior === 'allow') {
    // updatedInput 是整体替换，必须原样回传，否则字段会被清空
    decision['updatedInput'] = toolInput
    if (answers['always'] === '1') {
      decision['updatedPermissions'] = [
        { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'localSettings' },
      ]
    }
  } else {
    decision['message'] = '用户在飞书上拒绝了这次操作。'
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}

/**
 * 等作答的循环（从 runtime 里抽出来，好测）。
 *
 * 三种结局：
 *   · 有人答了 → 返回那条记录的决策
 *   · 人点了「我在电脑前」→ 交还终端（返回交还）
 *   · 每 probeMs 重探一次在场，人回到电脑前立刻交还（远程作答的前提是「人真的不在」）
 * 到点还没动静就落 'timeout'，不是「答过了」——否则点卡会回「已经答过了」，误导人。
 */
export async function waitForAnswer(id: string, deps: {
  getQuestion: (id: string) => PendingQuestion | null
  status: (id: string) => string | undefined
  handBack: (id: string, why: 'present' | 'timeout') => void
  present: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  probeMs?: number
  pollMs?: number
  deadline: number
}): Promise<{ outcome: 'answered'; question: PendingQuestion } | { outcome: 'handback'; why: 'hands' | 'present' | 'timeout' }> {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const probeMs = deps.probeMs ?? 3_000
  const pollMs = deps.pollMs ?? 500
  let lastProbe = now()
  while (now() < deps.deadline) {
    const cur = deps.getQuestion(id)
    if (!cur) return { outcome: 'handback', why: 'hands' }
    if (Object.keys(cur.answers).length) return { outcome: 'answered', question: cur }
    if (deps.status(id) === 'hands') return { outcome: 'handback', why: 'hands' }
    if (now() - lastProbe >= probeMs) {
      lastProbe = now()
      if (deps.present()) {
        deps.handBack(id, 'present')
        return { outcome: 'handback', why: 'present' }
      }
    }
    await sleep(pollMs)
  }
  deps.handBack(id, 'timeout')
  return { outcome: 'handback', why: 'timeout' }
}

/**
 * 工具授权卡（参考项目 qcards.buildPermissionCard）。
 *
 * 四个按钮就是四种答案，不靠人打「允许」两个字——自由文字分不清是在回答还是在说别的事，
 * 所以放行只认按钮（文字只认整行 1 / 2）。
 */
export function buildPermissionCard(
  id: string,
  p: PermissionInput,
  session: { chatId: string; threadId?: string; rootMessageId?: string; workspace?: string },
): unknown {
  return {
    kind: 'permission',
    id,
    toolName: p.tool_name ?? '未知工具',
    detail: permissionDetail(p.tool_input),
    workspace: session.workspace,
    chatId: session.chatId,
    threadId: session.threadId,
    rootMessageId: session.rootMessageId,
  }
}

/** 工具入参各工具不一样，挑人能看懂的那几个字段；都没有就贴 JSON（500 字截断）。 */
export function permissionDetail(input: unknown): string[] {
  const ti = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof ti[k] === 'string' ? (ti[k] as string) : '')
  const out: string[] = []
  const command = str('command')
  if (command) out.push('`' + command.slice(0, 400) + '`')
  const description = str('description')
  if (description) out.push(description.slice(0, 200))
  const filePath = str('file_path')
  if (filePath) out.push('文件：`' + filePath + '`')
  else if (str('path')) out.push('路径：`' + str('path') + '`')
  if (str('url')) out.push('地址：`' + str('url') + '`')
  if (!out.length) {
    let raw = ''
    try {
      raw = JSON.stringify(ti)
    } catch {
      raw = String(ti)
    }
    out.push('```\n' + (raw.length > 500 ? raw.slice(0, 500) + '…' : raw) + '\n```')
  }
  return out
}
