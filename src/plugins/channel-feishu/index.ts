/**
 * 飞书频道：把动作发到飞书。
 *
 * 实测：`lark-cli im +messages-send --as bot --chat-id <oc_> --msg-type text --content '{"text":"…"}'`，
 * 收事件时 content 是纯文本、**发消息要套 `{"text":…}`**，别统一「再解一层」。
 * CLI 没有幂等键参数，去重只能靠 outbox 的 dedupe_key。
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { Channel, PluginContext, SendResult } from '../../domain/ports.ts'
import type { CardState } from '../../domain/types.ts'
import type { Action } from '../../domain/types.ts'
import { runOnce } from '../../plugin-kit/spawn.ts'
import { assertNoPlaceholders, renderArgs } from '../../plugin-kit/template.ts'
import {
  renderCard,
  renderHereNoticeCard,
  renderPermissionCard,
  renderPickerCard,
  renderQuestionCard,
  renderResumeCard,
  renderNoticeCard,
  renderReadyCard,
  renderSettledCard,
} from './card.ts'

export const manifest = {
  id: 'channel-feishu',
  kind: 'channel' as const,
  config: z.object({
    binary: z.string().default('lark-cli'),
    defaultChatId: z.string().default(''),
    args: z.array(z.string()).default([
      'im',
      '+messages-send',
      '--as',
      'bot',
      '--chat-id',
      '{{chatId}}',
      '--msg-type',
      'text',
      '--content',
      '{{content}}',
    ]),
    timeoutMs: z.number().int().positive().default(60_000),
    /** 从 CLI 的 JSON 输出里取新消息 id 的路径；取不到就不返回 id（话题绑定需要它） */
    messageIdPath: z.string().default('data.message_id'),
    /** 发卡：--content 直接就是卡片 JSON */
    /** 在某个话题里回一张卡（`--reply-in-thread`）：话题群里所有卡都走这条 */
    cardReplyArgs: z.array(z.string()).default([
      'im',
      '+messages-reply',
      '--as',
      'bot',
      '--message-id',
      '{{replyTo}}',
      '--reply-in-thread',
      '--msg-type',
      'interactive',
      '--content',
      '{{card}}',
    ]),
    cardArgs: z.array(z.string()).default([
      'im',
      '+messages-send',
      '--as',
      'bot',
      '--chat-id',
      '{{chatId}}',
      '--msg-type',
      'interactive',
      '--content',
      '{{card}}',
    ]),
    /** 按人私聊（重点消息）：--user-id 与 --chat-id 互斥，幂等键 ≤50 字符 */
    dmArgs: z.array(z.string()).default([
      'im',
      '+messages-send',
      '--as',
      'bot',
      '--user-id',
      '{{userId}}',
      '--msg-type',
      'interactive',
      '--content',
      '{{card}}',
      '--idempotency-key',
      '{{dedupeKey}}',
    ]),
    /** 下载消息里的图片；输出路径必须相对 cwd（CLI 只允许根目录之下） */
    downloadImageArgs: z.array(z.string()).default([
      'im',
      '+messages-resources-download',
      '--as',
      'bot',
      '--message-id',
      '{{messageId}}',
      '--file-key',
      '{{fileKey}}',
      '--type',
      'image',
      '--output',
      '{{outPath}}',
    ]),
    /** 建卡后顺手置顶（不想置顶就设 false） */
    pinCards: z.boolean().default(false),
    /**
     * 预演：只把「要执行的命令行」写进日志，不真的调 CLI。
     * 用来在切换前看清「它到底会发什么」，也用来跑离线端到端。
     */
    dryRun: z.boolean().default(false),
    pinCreateArgs: z.array(z.string()).default(['im', 'pins', 'create', '--as', 'bot', '--data', '{"message_id":"{{messageId}}"}']),
    /** 对账用：列这个会话的置顶（翻页 token 由代码追加，空页不传） */
    pinListArgs: z.array(z.string()).default([
      'im',
      'pins',
      'list',
      '--as',
      'bot',
      '--chat-id',
      '{{chatId}}',
      '--page-size',
      '50',
    ]),
    // 实测：pins delete 属于 high-risk-write，必须带 --yes，否则 CLI 直接拒绝
    pinDeleteArgs: z.array(z.string()).default([
      'im',
      'pins',
      'delete',
      '--as',
      'bot',
      '--message-id',
      '{{messageId}}',
      '--yes',
    ]),
    /** 改卡：im messages patch --data '{"content":"<卡片 JSON 字符串>"}' */
    patchCardArgs: z.array(z.string()).default([
      'im',
      'messages',
      'patch',
      '--as',
      'bot',
      '--message-id',
      '{{messageId}}',
      '--data',
      '{{data}}',
    ]),
    /** 回到某个话题里：回复根消息并 --reply-in-thread */
    replyArgs: z.array(z.string()).default([
      'im',
      '+messages-reply',
      '--as',
      'bot',
      '--message-id',
      '{{replyTo}}',
      '--reply-in-thread',
      '--msg-type',
      'text',
      '--content',
      '{{content}}',
    ]),
  }),
}

/** 按卡片种类挑渲染器：状态卡是默认，其余三种各有自己的形状。 */
function renderAnyCard(card: unknown): unknown {
  // 场景自己拼好的飞书卡（header/elements）直接透传，不再按内核 CardState 渲染。
  if (typeof card === 'object' && card !== null && 'header' in card) return card
  const kind = (card as { kind?: string }).kind
  if (kind === 'picker') return renderPickerCard(card as never)
  if (kind === 'resume') return renderResumeCard(card as never)
  if (kind === 'question') return renderQuestionCard(card as never)
  if (kind === 'permission') return renderPermissionCard(card as never)
  if (kind === 'here-notice') return renderHereNoticeCard(card as never)
  if (kind === 'settled') return renderSettledCard(card as never)
  if (kind === 'notice') return renderNoticeCard(card as never)
  if (kind === 'ready') return renderReadyCard(card as never)
  return renderCard(card as CardState)
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  const cfg = ctx.config
  let dryCounter = 0

  /** 预演：把渲染后的参数记成一行日志，返回一个假消息 id（让链路能继续走）。 */
  const dry = (what: string, args: readonly string[]): { status: 'sent'; messageId: string } => {
    dryCounter++
    ctx.log('info', `[预演] ${what}：${cfg.binary} ${args.join(' ')}`)
    return { status: 'sent', messageId: `om_dry_${dryCounter}` }
  }

  const channel: Channel = {
    async send(a: Action, dedupeKey: string): Promise<SendResult> {
      if (a.kind !== 'reply_only') {
        throw new Error(`channel-feishu 只支持 reply_only，收到 ${a.kind}`)
      }
      const replyTo = a.replyTo
      const chatId = a.chatId ?? cfg.defaultChatId
      if (!replyTo && !chatId) throw new Error('channels.feishu.defaultChatId 未配置，不知道发到哪')

      const args = renderArgs(replyTo ? cfg.replyArgs : cfg.args, {
        chatId,
        replyTo: replyTo ?? '',
        // 收文本是裸的、发文本要套一层，这里统一从代码生成，避免手写 JSON 出错
        content: JSON.stringify({ text: a.text }),
        dedupeKey,
        text: a.text,
      })
      assertNoPlaceholders(args)
      if (cfg.dryRun) return dry('发文本', args)

      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) {
        throw new Error(`飞书发送失败（exit=${r.code}）：${r.stderr.trim().slice(0, 300)}`)
      }
      ctx.log('info', `已发送到 ${chatId}（${dedupeKey}）`)
      return { status: 'sent', messageId: pickMessageId(r.stdout, cfg.messageIdPath) }
    },

    /** 发一张卡：`--msg-type interactive`，content 就是卡片 JSON 本身。 */
    async sendCard(a, dedupeKey): Promise<SendResult> {
      const chatId = a.chatId || cfg.defaultChatId
      if (!chatId) throw new Error('channels.feishu.defaultChatId 未配置，不知道发到哪')
      const args = renderArgs(a.replyTo ? cfg.cardReplyArgs : cfg.cardArgs, {
        chatId,
        replyTo: a.replyTo ?? '',
        card: JSON.stringify(renderAnyCard(a.card)),
        dedupeKey,
      })
      assertNoPlaceholders(args)
      if (cfg.dryRun) return dry('发卡', args)
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) throw new Error(`发卡失败（exit=${r.code}）：${r.stderr.trim().slice(0, 300)}`)
      const messageId = pickMessageId(r.stdout, cfg.messageIdPath)
      // 拿不到 id 就明确失败：卡已经发出去了，但没有 id 就没法原地更新、没法置顶、
      // 话题也绑不上——静默返回 sent 等于把「这张卡以后永远是死的」记成成功。
      if (!messageId) {
        throw new Error(`发卡成功但没解析到消息 id（检查 messageIdPath）：${r.stdout.trim().slice(0, 200)}`)
      }
      if (a.pin && cfg.pinCards) {
        // 置顶失败不该打挂发卡，最多提示一句
        await channel.pinMessage?.(messageId, true).catch((e: unknown) =>
          ctx.log('warn', `置顶失败（不影响发卡）：${e instanceof Error ? e.message : String(e)}`),
        )
      }
      ctx.log('info', `已发卡到 ${a.replyTo ? `话题 ${a.replyTo}` : chatId}（${dedupeKey}）`)
      return { status: 'sent', messageId }
    },

    /** 原地改卡：飞书的 patch 接口只认自己发的 interactive 消息，且限 14 天内。 */
    async patchCard(messageId, card): Promise<void> {
      const args = renderArgs(cfg.patchCardArgs, {
        messageId,
        // 飞书要求 content 是「JSON 字符串再套一层」，这里统一由代码序列化
        data: JSON.stringify({ content: JSON.stringify(renderAnyCard(card)) }),
      })
      assertNoPlaceholders(args)
      if (cfg.dryRun) {
        dry('改卡', args)
        return
      }
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) throw new Error(`改卡失败（exit=${r.code}）：${r.stderr.trim().slice(0, 300)}`)
      ctx.log('info', `已改卡 ${messageId}`)
    },

    /** 按人私聊一张卡：`--user-id ou_…` 直发，不需要先知道 p2p 会话 id。 */
    async sendDm(a, dedupeKey): Promise<SendResult> {
      if (!a.userId) throw new Error('私聊缺少 userId（open_id）')
      const args = renderArgs(cfg.dmArgs, {
        userId: a.userId,
        card: JSON.stringify(renderAnyCard(a.card)),
        dedupeKey: dedupeKey.slice(0, 50),
      })
      assertNoPlaceholders(args)
      if (cfg.dryRun) return dry('私聊发卡', args)
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) throw new Error(`私聊发卡失败（exit=${r.code}）：${r.stderr.trim().slice(0, 300)}`)
      const messageId = pickMessageId(r.stdout, cfg.messageIdPath)
      ctx.log('info', `已私聊发卡给 ${a.userId}（${dedupeKey}）`)
      return { status: 'sent', messageId }
    },

    async pinMessage(messageId, pin): Promise<void> {
      const args = renderArgs(pin ? cfg.pinCreateArgs : cfg.pinDeleteArgs, { messageId })
      assertNoPlaceholders(args)
      if (cfg.dryRun) {
        dry(pin ? '置顶' : '取消置顶', args)
        return
      }
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) throw new Error(`置顶操作失败（exit=${r.code}）：${r.stderr.trim().slice(0, 200)}`)
    },

    /** 查这条消息所在话题的 thread id（omt_…）：根消息 id ≠ 话题 id。 */
    async threadIdOf(messageId: string): Promise<string | undefined> {
      if (cfg.dryRun) return undefined
      const r = await runOnce({
        binary: cfg.binary,
        args: ['im', '+messages-mget', '--as', 'bot', '--message-id', messageId],
        timeoutMs: cfg.timeoutMs,
      })
      if (r.code !== 0) return undefined
      try {
        const j = JSON.parse(r.stdout) as { data?: { messages?: { thread_id?: string }[] } }
        return j.data?.messages?.[0]?.thread_id
      } catch {
        return undefined
      }
    },

    async isOwnMessage(messageId: string): Promise<boolean | undefined> {
      if (cfg.dryRun) return undefined
      const r = await runOnce({
        binary: cfg.binary,
        args: ['im', '+messages-mget', '--as', 'bot', '--message-id', messageId],
        timeoutMs: cfg.timeoutMs,
      })
      if (r.code !== 0) return undefined
      try {
        const j = JSON.parse(r.stdout) as { data?: { messages?: { sender?: { sender_type?: string }; content?: string }[] } }
        const m = j.data?.messages?.[0]
        if (!m) return undefined
        // 机器人发的卡：正文是 `<card …>`，或 sender_type 是 app
        return m.sender?.sender_type === 'app' || (m.content ?? '').trimStart().startsWith('<card')
      } catch {
        return undefined
      }
    },

    /** 群里的置顶列表：对账用，翻页到最后一页。 */
    async listPins(chatId: string): Promise<{ messageId: string; operatorIdType?: string }[]> {
      if (cfg.dryRun) return []
      const out: { messageId: string; operatorIdType?: string }[] = []
      let pageToken = ''
      for (let page = 0; page < 10; page++) {
        const args = renderArgs(cfg.pinListArgs, { chatId })
        if (pageToken) args.push('--page-token', pageToken)
        assertNoPlaceholders(args)
        const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
        if (r.code !== 0) throw new Error(`读置顶列表失败（exit=${r.code}）：${r.stderr.trim().slice(0, 200)}`)
        const j = JSON.parse(r.stdout) as {
          data?: {
            items?: { message_id?: string; operator_id_type?: string }[]
            has_more?: boolean
            page_token?: string
          }
        }
        for (const it of j.data?.items ?? []) {
          if (it.message_id) out.push({ messageId: it.message_id, operatorIdType: it.operator_id_type })
        }
        if (!j.data?.has_more || !j.data.page_token) break
        pageToken = j.data.page_token
      }
      return out
    },

    async downloadImage(a): Promise<string> {
      if (cfg.dryRun) {
        dry('下载图片', renderArgs(cfg.downloadImageArgs, {
          messageId: a.messageId,
          fileKey: a.fileKey,
          outPath: a.outPath,
        }))
        return a.outPath
      }
      mkdirSync(dirname(a.outPath), { recursive: true })
      const args = renderArgs(cfg.downloadImageArgs, {
        messageId: a.messageId,
        fileKey: a.fileKey,
        outPath: a.outPath,
      })
      assertNoPlaceholders(args)
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) throw new Error(`下载图片失败（exit=${r.code}）：${r.stderr.trim().slice(0, 200)}`)
      return a.outPath
    },
  }

  ctx.register(channel)
}

/**
 * 从 CLI 输出里取消息 id。
 * 实测：`lark-cli` 默认输出是**多行美化 JSON**（不是 NDJSON），所以不能只按行解析。
 * 顺序：整体 JSON → NDJSON 每行 → 从后往前抠一个平衡的 `{...}` 块。
 */
export function pickMessageId(stdout: string, path: string): string | undefined {
  const tryParse = (text: string): string | undefined => {
    try {
      const v = getPath(JSON.parse(text) as unknown, path)
      return typeof v === 'string' && v ? v : undefined
    } catch {
      return undefined
    }
  }

  const whole = tryParse(stdout.trim())
  if (whole) return whole

  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    const hit = tryParse(t)
    if (hit) return hit
  }

  // 多行 JSON：从最后一个 `{` 往回找能配平的块
  const end = stdout.lastIndexOf('}')
  if (end >= 0) {
    for (let start = stdout.lastIndexOf('{', end); start >= 0; start = stdout.lastIndexOf('{', start - 1)) {
      const hit = tryParse(stdout.slice(start, end + 1))
      if (hit) return hit
      if (start === 0) break
    }
  }
  return undefined
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}
