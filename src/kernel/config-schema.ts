/**
 * 配置页的字段描述（参考项目「页面不认识任何字段名」的做法）。
 *
 * 两段拼起来：
 *   1. 手写中文名/单位/可选项/只读标记（LABELS）——这些是给用户看的措辞，代码里推不出来；
 *   2. 从**当前加载出来的配置对象**递归展开，凡是 LABELS 里没写的键，自动出现成一个通用输入框。
 * 所以新加一个配置项不用改这个文件，只是名字会显示成路径本身。
 */

export type FieldKind = 'bool' | 'number' | 'text' | 'select' | 'json' | 'readonly'

export interface ConfigField {
  path: string
  label: string
  kind: FieldKind
  group: string
  options?: string[]
  /** 单位或取值范围，给输入框后面挂着 */
  hint?: string
  note?: string
}

interface Label {
  label: string
  kind?: FieldKind
  options?: string[]
  hint?: string
  note?: string
}

/** 中文名与控件类型。没写的键会退化成普通文本框（名称就是路径）。 */
const LABELS: Record<string, Label> = {
  mode: {
    label: '运行档位',
    kind: 'select',
    options: ['observe', 'suggest', 'auto'],
    note: 'observe 只看不动；suggest 给出建议；auto 真的开窗口干活',
  },
  'log.level': { label: '日志级别', kind: 'select', options: ['debug', 'info', 'warn', 'error'] },
  'store.path': { label: '数据库路径', kind: 'readonly', note: '改这个要重开程序' },

  contextWindow: {
    label: '上下文窗口大小',
    kind: 'number',
    hint: 'tokens',
    note: '用量那一行的分母，仅作兜底：优先用 claude 自己声明的窗口；0 = 不知道，不画百分比',
  },

  'cleanup.enabled': { label: '自动清理过期数据', kind: 'bool' },
  'cleanup.imageTtlDays': { label: '图片保留天数', kind: 'number', hint: '天' },
  'cleanup.mappingTtlDays': { label: '消息映射保留天数', kind: 'number', hint: '天' },
  'cleanup.questionTtlHours': { label: '未答提问保留小时', kind: 'number', hint: '小时' },
  'cleanup.maxLogBytes': { label: '单个日志上限', kind: 'number', hint: '字节' },
  'cleanup.spawnTtlDays': { label: '一次性会话转录保留天数', kind: 'number', hint: '天' },

  'sessions.newTopicPolicy': {
    label: '群里新消息怎么处理',
    kind: 'select',
    options: ['judge', 'open'],
    note: 'open = 群里的新消息当成要开窗口；judge = 交给判断层',
  },
  'sessions.choiceTtlMs': { label: '待选列表有效期', kind: 'number', hint: '毫秒' },
  'sessions.replyCooldownMs': { label: '回执冷却', kind: 'number', hint: '毫秒' },
  'sessions.cardRefreshMs': { label: '状态卡刷新间隔', kind: 'number', hint: '毫秒' },

  'auto_reply.enabled': { label: '启用自动回复', kind: 'bool' },
  'auto_reply.pollSeconds': { label: '自动回复巡检间隔', kind: 'number', hint: '秒' },
  'auto_reply.cooldownSeconds': { label: '同一窗口自动回复冷却', kind: 'number', hint: '秒' },
  'auto_reply.policies': {
    label: '自动回复策略',
    kind: 'json',
    note: '一条策略 = 一句回复 + 一组触发条件；见 config/lingcub.yaml 里的例子',
  },

  'channels.feishu.defaultChatId': { label: '飞书默认群 chatId', hint: 'oc_ 开头' },
  'channels.feishu.pinCards': { label: '状态卡自动置顶', kind: 'bool' },
  'channels.feishu.binary': { label: '飞书命令行', kind: 'readonly' },

  // 控制台场景（v2）：开窗向导与重点私聊的开关，都落在覆盖层里，页面直接改
  'scenarios.console.openOnMessage': {
    label: '群消息直接开窗',
    kind: 'bool',
    note: '打开后：这个话题群里的普通消息 = 「在这开个窗口」，先选执行器再选工作区',
  },
  'scenarios.console.workspaceMax': { label: '工作区候选上限', kind: 'number', hint: '个' },
  'scenarios.focus-dm.enabled': { label: '启用重点私聊', kind: 'bool' },
  'scenarios.focus-dm.dmChatId': { label: '重点私聊会话 id', hint: 'oc_ 开头（与机器人的 p2p）' },
  'scenarios.focus-dm.dmUserId': { label: '重点私聊收件人 open_id', hint: 'ou_ 开头；填了就不用 p2p 会话 id' },
  'scenarios.focus-dm.notifyOnAsk': { label: '等你决策时私聊', kind: 'bool' },
  'scenarios.focus-dm.notifyOnTurnEnd': { label: '任务完成时私聊', kind: 'bool', note: '多窗口会吵，默认关' },
  'scenarios.focus-dm.notifyOnOpenFailed': { label: '开窗失败时私聊', kind: 'bool' },
  'scenarios.focus-dm.dedupeMinutes': { label: '私聊去重窗口', kind: 'number', hint: '分钟' },
  'scenarios.focus-dm.batchMs': { label: '多窗口聚合间隔', kind: 'number', hint: '毫秒' },

  'classifiers.llm.minConfidence': { label: '分类置信度门槛', kind: 'number', hint: '0-1' },
  'classifiers.llm.binary': { label: '分类器命令', kind: 'readonly' },
}

/** 这些前缀整片跳过：执行器策略属于平台事实，页面上不给改。 */
const SKIP_PREFIX = ['executor_policies.']
/** 这些键名跳过：命令行参数、字段映射、插件名——写了也用不上，只会把页面撑乱。 */
const SKIP_KEYS = new Set([
  'args',
  'replyArgs',
  'cardArgs',
  'cardReplyArgs',
  'logsArgs',
  'stopArgs',
  'pinArgs',
  'pinDeleteArgs',
  'fields',
  'prompt',
  'plugin',
])

function groupOf(path: string): string {
  const top = path.split('.')[0] ?? ''
  const names: Record<string, string> = {
    mode: '总览',
    log: '总览',
    store: '总览',
    contextWindow: '总览',
    cleanup: '清理',
    sessions: '会话',
    scenarios: '场景',
    auto_reply: '自动回复',
    channels: '频道',
    classifiers: '分类器',
    sources: '来源',
    executor_policies: '执行器',
    rules: '规则',
    projects: '项目',
  }
  return names[top] ?? '其它'
}

function kindOf(path: string, value: unknown, label?: Label): FieldKind {
  if (label?.kind) return label.kind
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return 'json'
  return 'text'
}

/**
 * 把配置对象展开成字段表。
 * @param config 当前生效的配置（含默认值）
 */
export function describeConfig(config: unknown): ConfigField[] {
  const out: ConfigField[] = []
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      const label = LABELS[prefix]
      const kind = kindOf(prefix, node, label)
      out.push({
        path: prefix,
        label: label?.label ?? prefix,
        kind,
        group: groupOf(prefix),
        options: label?.options,
        hint: label?.hint,
        note: label?.note,
      })
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (SKIP_KEYS.has(key)) continue
      if (SKIP_PREFIX.some((p) => `${path}.`.startsWith(p)) && LABELS[path] === undefined) continue
      walk(value, path)
    }
  }
  walk(config, '')

  // LABELS 里有、配置里没出现的键（比如默认值被省略）也补上，页面才认得它
  for (const [path, label] of Object.entries(LABELS)) {
    if (out.some((f) => f.path === path)) continue
    out.push({
      path,
      label: label.label,
      kind: label.kind ?? 'text',
      group: groupOf(path),
      options: label.options,
      hint: label.hint,
      note: label.note,
    })
  }
  return out.sort((a, b) => (a.group === b.group ? a.path.localeCompare(b.path) : a.group.localeCompare(b.group)))
}

/** 页面上能改的字段：只读的不算。 */
export function editablePaths(config: unknown): string[] {
  return describeConfig(config)
    .filter((f) => f.kind !== 'readonly')
    .map((f) => f.path)
}
