/**
 * 钉钉消息正文里的命令行噪声清洗。
 *
 * DWS 把媒体消息（图片/文件/语音/视频）返回成占位符 + 一句“注意：如需下载使用 dws chat message
 * download-media 命令下载”。这句是 CLI 写给读输出的 agent 的操作提示，不是发送人说的话，
 * 展示给人和喂给模型前都要去掉；原始载荷仍留在 Event.raw 里。
 */

const DWS_MEDIA_NOTICE_RE = /注意[:：]\s*如需下载使用[^。\n]*?命令下载[。.]?/g

export function stripDwsMediaNotice(text: string): string {
  if (!text.includes('命令下载')) return text
  return text.replace(DWS_MEDIA_NOTICE_RE, '').replace(/[ \t]{2,}/g, ' ').trim()
}
