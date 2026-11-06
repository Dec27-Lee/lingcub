/** 从执行器输出里抽 JSON：不同 CLI 的事件包裹层不同，答案可能在 text/content/result 任一层。 */

export function harvest(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || node === null) return
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const x of node) harvest(x, out, depth + 1)
    return
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) harvest(v, out, depth + 1)
  }
}

/** 取一段文本里最后一个配平的 JSON 对象；配不平返回 null。 */
export function lastJsonObject(text: string): string | null {
  const end = text.lastIndexOf('}')
  if (end < 0) return null
  let depth = 0
  let inString = false
  for (let i = end; i >= 0; i--) {
    const ch = text[i]!
    if (ch === '"' && text[i - 1] !== '\\') inString = !inString
    if (inString) continue
    if (ch === '}') depth++
    else if (ch === '{') {
      depth--
      if (depth === 0) return text.slice(i, end + 1)
    }
  }
  return null
}

/** NDJSON 或纯文本输出 → 最后一个可解析的 JSON 对象；找不到返回 null。 */
export function extractJson(stdout: string): unknown {
  // lark-cli 默认输出缩进 JSON：先按整段解析，别按行拆（缩进行单独都不是合法 JSON）。
  const whole = stdout.trim()
  if (whole) {
    try {
      const parsed = JSON.parse(whole) as unknown
      // 只有 lark-cli 这类 {ok,data} 信封才整段优先；执行器事件包裹仍要取里面的文本 JSON。
      const env = parsed as { ok?: unknown; data?: unknown }
      if (env && typeof env === 'object' && ('ok' in env || 'data' in env)) return parsed
    } catch {
      /* 不是整段 JSON，继续按行找 */
    }
  }
  const texts: string[] = []
  const envelopes: string[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      envelopes.push(t)
      harvest(JSON.parse(t) as unknown, texts)
    } catch {
      texts.push(t)
    }
  }
  // 先看事件里携带的文本（最具体），整行 envelope 放最后兜底。
  for (const text of [...texts.reverse(), ...envelopes.reverse()]) {
    const json = lastJsonObject(text)
    if (!json) continue
    try {
      const parsed = JSON.parse(json) as unknown
      return parsed
    } catch {
      continue
    }
  }
  return null
}

/** 一行输出里所有可读文本，用于把进度写成一句人话。 */
export function textOf(node: unknown): string {
  const out: string[] = []
  harvest(node, out)
  return out.filter((s) => s.trim()).join(' ').slice(0, 1000)
}
