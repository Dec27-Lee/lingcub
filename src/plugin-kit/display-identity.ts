/** 展示层的身份归一：自己发出的钉钉消息统一显示“我”，不改 Event。 */

export const SELF_DINGTALK_SOURCE = 'source-dingtalk-sent'

export function displaySender(source: string | undefined, name?: string, id?: string): string {
  if (source === SELF_DINGTALK_SOURCE) return '我'
  return name || id || '未知'
}
