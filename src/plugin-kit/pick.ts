/** 从扁平化事件里按点路径取值。字段名属于平台事实，由各 source 插件的 config.fields 声明。 */

export function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** 只接受 string / number / boolean，其余一律 undefined，避免把对象塞进 Event 字段。 */
export function pickScalar(obj: unknown, path: string): string | undefined {
  const v = pick(obj, path)
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}
