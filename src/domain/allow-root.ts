/** 纯路径门禁：工作区根必须落在 allowRoots 内。内核与插件共用。 */
export function assertAllowedRoot(root: string, allowRoots: readonly string[]): void {
  // 末尾分隔符归一，大小写不敏感：Windows 路径比较的唯一可靠口径。
  const norm = (s: string) => s.replace(/[\\/]+$/, '').toLowerCase()
  const r = norm(root)
  const ok = allowRoots.some((a) => r === norm(a) || r.startsWith(norm(a) + '\\'))
  if (!ok) throw new Error(`工作区 ${root} 不在允许根内：${allowRoots.join(', ') || '(空)'}`)
}
