/**
 * 钩子配置的形状（装进 claude `settings.json` 的那份）。
 *
 * 这里只放「装什么形状」这个事实，落盘逻辑还在 main.ts 里（要备份、要幂等剔除旧条目）。
 * 数值来自参考项目 `feishu-bridge-claude/setup/hooks-config.js:58-70` 的实测结论：
 *   · 代答类钩子（AskUserQuestion / PermissionRequest）会阻塞等人作答，钩子 timeout 必须比
 *     等待上限长——官方文档里 timeout 是默认值不是上限，写 1900 秒有效；默认 60 秒会把
 *     「人还在手机上点」的那一轮直接掐断，答案再也回不到 claude。
 *   · matcher 不是装饰：PreToolUse 不带 matcher 会对每个工具调用都跑一次钩子。
 */

export const HOOK_WAIT_SECONDS = 1900

export interface HookSpec {
  matcher?: string
  timeout?: number
}

export const HOOK_SPECS = {
  stop: { timeout: 25 },
  notify: { matcher: 'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input', timeout: 25 },
  /** 只有出题这一个工具需要代答；别的工具调用不该被钩子拦一道 */
  ask: { matcher: 'AskUserQuestion', timeout: HOOK_WAIT_SECONDS },
  /** 权限确认按工具放行：这几个才可能弹确认框 */
  permission: {
    matcher: 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch',
    timeout: HOOK_WAIT_SECONDS,
  },
  sessionStart: { timeout: 10 },
} as const satisfies Record<string, HookSpec>

/** 一条钩子条目（`{ matcher?, hooks: [{ type, command, timeout? }] }`）。 */
export function hookGroup(command: string, spec: HookSpec = {}): Record<string, unknown> {
  const hook: Record<string, unknown> = { type: 'command', command }
  if (spec.timeout) hook['timeout'] = spec.timeout
  const group: Record<string, unknown> = { hooks: [hook] }
  if (spec.matcher) group['matcher'] = spec.matcher
  return group
}

/** 这条组里是不是装着这个命令（用来把旧形状的条目剔掉再重写）。 */
export function groupHasCommand(group: unknown, command: string): boolean {
  const hooks = (group as { hooks?: { command?: string }[] } | null)?.hooks ?? []
  return hooks.some((h) => h?.command === command)
}

/**
 * 把一条钩子合并进某个事件的已有列表：同 command 的旧条目先剔掉再按新形状加回去。
 * 别的来源的条目（例如 codegraph 的 UserPromptSubmit）原样保留。
 */
export function mergeHookEntry(existing: unknown, command: string, spec: HookSpec = {}): unknown[] {
  const list = Array.isArray(existing) ? existing : []
  return [...list.filter((g) => !groupHasCommand(g, command)), hookGroup(command, spec)]
}
