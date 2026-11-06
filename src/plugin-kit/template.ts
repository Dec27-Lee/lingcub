/** 参数模板：`{{name}}` 占位替换。命令与参数属于平台事实，写在 config 里，不写死在代码里。 */

export function renderArgs(args: readonly string[], vars: Readonly<Record<string, string>>): string[] {
  return args.map((a) => a.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole))
}

/** 渲染后若仍有未替换的占位符，说明配置写了代码没提供的变量，直接失败，不静默吞掉。 */
export function assertNoPlaceholders(args: readonly string[]): void {
  const left = args.filter((a) => /\{\{\w+\}\}/.test(a))
  if (left.length) throw new Error(`参数模板存在未提供的变量：${left.join(' ')}`)
}
