/** 卡片回调归一：只有这里认识飞书的 `card.action.trigger` 原始载荷，内核只收 CardAction。 */

export interface CardAction {
  /** 平台事件 id（幂等依据） */
  id: string
  chatId: string
  messageId?: string
  actorId?: string
  actionTag?: string
  /** 按钮 value 解析后的对象 */
  action: Record<string, unknown>
  /** 原始 action_value 字符串（内核解析回放用，保持字节一致） */
  rawAction: string
}

export function parseCardAction(payload: unknown): CardAction | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (p['type'] !== 'card.action.trigger') return null
  const id = typeof p['event_id'] === 'string' ? p['event_id'] : ''
  const chatId = typeof p['chat_id'] === 'string' ? p['chat_id'] : ''
  const rawAction = typeof p['action_value'] === 'string' ? p['action_value'] : ''
  if (!id || !chatId || !rawAction) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawAction) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return {
    id,
    chatId,
    messageId: typeof p['message_id'] === 'string' ? p['message_id'] : undefined,
    actorId: typeof p['operator_id'] === 'string' ? p['operator_id'] : undefined,
    actionTag: typeof p['action_tag'] === 'string' ? p['action_tag'] : undefined,
    action: parsed as Record<string, unknown>,
    rawAction,
  }
}
