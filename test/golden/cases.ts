/** 40 条固定输入：10 类消息 × 3 种判断 + 3 种档位 + 7 条命令。 */

import { ev, intent, EMPTY_RULES, type GoldenCase } from './harness.ts'

const bases = [
  { name: '群聊-bug', event: ev('om_b1', { text: '登录页点导出报错 500' }) },
  { name: '私聊-问句', event: ev('om_b2', { channel: { kind: 'dm', id: 'oc_dm' }, text: '这个接口怎么调？' }) },
  { name: '群聊-@我', event: ev('om_b3', { atMe: true, text: '@我 看下这个报错' }) },
  { name: '群聊-闲聊', event: ev('om_b4', { text: '今天天气不错' }) },
  { name: '文档-待办', event: ev('om_b5', { channel: { kind: 'doc', id: 'doc_1' }, text: '文档待办：补充接口说明' }) },
  { name: '待办-任务', event: ev('om_b6', { channel: { kind: 'task', id: 'task_1' }, text: '待办：修登录' }) },
  { name: '空正文', event: ev('om_b7', { text: '' }) },
  { name: '图片消息', event: ev('om_b8', { text: '看这张图', imageKey: 'img_1' }) },
  { name: '引用回复', event: ev('om_b9', { text: '这个还是不行', replyTo: 'om_prev' }) },
  { name: '未知项目', event: ev('om_b10', { text: '验收一下' }) },
] as const

function withVerdict(
  e: ReturnType<typeof ev>,
  kind: 'bug' | 'question' | 'none',
): GoldenCase['verdict'] {
  if (kind === 'none') return null
  if (kind === 'question') {
    return intent({
      eventId: e.id,
      kind: 'question',
      suggestedAction: 'reply_only',
      topic: '问一下',
      rationale: '问句',
      confidence: 0.8,
    })
  }
  return intent({ eventId: e.id })
}

const cases: GoldenCase[] = []
for (const b of bases) {
  for (const kind of ['bug', 'question', 'none'] as const) {
    cases.push({ name: `${b.name}-${kind}`, event: b.event, verdict: withVerdict(b.event, kind) })
  }
}

const bug = bases[0].event
cases.push({ name: 'observe-档', event: bug, verdict: withVerdict(bug, 'bug'), mode: 'observe' })
cases.push({ name: 'suggest-档', event: bug, verdict: withVerdict(bug, 'bug'), mode: 'suggest' })
cases.push({
  name: '规则命中',
  event: ev('om_rule', { text: '这个 bug 又出现了' }),
  verdict: null,
  rules: {
    rules: [
      {
        id: 'always',
        when: { always: true },
        then: { kind: 'bug', topic: '规则命中', project: 'personal-lingcub', confidence: 0.95 },
      },
    ],
    allowlist: { groups: [], people: [], keywords: [] },
  },
})

for (const text of ['#help', '#目录', '#状态', '#停止', '#新会话', '#不存在命令', 'E:\\Develop_E\\lingcub']) {
  cases.push({
    name: `命令-${text}`,
    event: ev(`om_cmd_${cases.length}`, { text }),
    verdict: null,
    rules: EMPTY_RULES,
  })
}

const prepBound: GoldenCase['prep'] = (store) => {
  const t = '2026-11-03T09:00:00.000Z'
  store.insertSession({
    id: 'sess-gold',
    chatId: 'oc_1',
    threadId: 'th_1',
    rootMessageId: 'om_root',
    ownerId: 'ou_1',
    title: '金标窗口',
    executor: 'dsh',
    workspace: 'personal-lingcub',
    sessionId: 'exec-1',
    status: 'active',
    createdAt: t,
    lastActiveAt: t,
  })
}

cases.push(
  {
    name: '已绑定-#status',
    event: ev('om_st1', { text: '#status', threadId: 'th_1' }),
    verdict: null,
    prep: prepBound,
  },
  {
    name: '已绑定-#new',
    event: ev('om_new1', { text: '#new', threadId: 'th_1' }),
    verdict: null,
    prep: prepBound,
  },
  {
    name: '已绑定-#stop',
    event: ev('om_st3', { text: '#stop', threadId: 'th_1' }),
    verdict: null,
    prep: prepBound,
  },
  {
    name: '已绑定-#停止',
    event: ev('om_st2', { text: '#停止', threadId: 'th_1' }),
    verdict: null,
    prep: prepBound,
  },
)

export const CASES: readonly GoldenCase[] = cases
