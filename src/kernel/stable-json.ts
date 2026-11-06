/** 稳定 JSON：对象按键排序，保证同一语义输入得到同一 digest / id。 */

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null'
  } catch {
    return String(v)
  }
}

export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`
}
