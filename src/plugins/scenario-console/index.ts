/**
 * 控制台场景：飞书话题里的窗口控制。
 *
 * 两条路：
 *   1. 已绑定话题：命令（#status/#stop/…）与提问作答；正文由 session-post 投给窗口。
 *   2. 未绑定消息（开窗向导）：选执行器 → 选工作区 → session.open。
 *      状态全部跟着卡片按钮的 value 走，不额外落表，重启也不丢。
 */

import { basename } from 'node:path'
import { renderExecutorCard, renderResumeCard, renderWorkspaceCard } from '../../plugin-kit/feishu-cards.ts'
import { z } from 'zod'
import type { CardAction } from '../../domain/card-action.ts'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event, Session } from '../../domain/types.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-console',
  roles: ['scenario'],
  wants: [
    'state.session.route',
    'state.session.get',
    'state.session.history',
    'state.session.live',
    'state.workspace.get',
    'state.question.get',
    'notify.reply',
    'notify.card.send',
    'notify.card.pin',
    'workspace.list',
    'workspace.trust',
    'session.open',
    'session.start',
    'session.attach',
    'session.stop',
    'session.close',
    'session.answer',
  ],
  on: ['message.received', 'session.ask.requested', 'session.permission.requested', 'card.action'],
  owns: ['status', 'stop', 'new'],
  config: z
    .object({
      /**
       * 只处理这些来源的消息：控制台发卡/回话固定走飞书频道（chatId、messageId 都是飞书的），
       * 用钉钉的 id 发过去必被拒、在发件箱里积成死信。填真实 source id，不是渠道名。
       */
      sources: z
        .array(z.string())
        .default(['source-feishu-im', 'source-feishu-card', 'source-feishu-card-v2']),
      commands: z.array(z.string()).default(['#status', '#状态']),
      stopCommands: z.array(z.string()).default(['#stop', '#停']),
      newCommands: z.array(z.string()).default(['#new', '#新窗口']),
      helpCommands: z.array(z.string()).default(['#help', '#帮助']),
      resumeCommands: z.array(z.string()).default(['#resume', '#恢复']),
      attachCommands: z.array(z.string()).default(['#接入', '#attach']),
      pinCommands: z.array(z.string()).default(['#pin']),
      unpinCommands: z.array(z.string()).default(['#unpin']),
      resumeMax: z.number().int().positive().max(8).default(8),
      /** 未绑定的普通消息是否当「开一个窗口」的请求（控制台群用） */
      openOnMessage: z.boolean().default(false),
      /** 工作区候选最多列几个 */
      workspaceMax: z.number().int().positive().max(20).default(20),
      helpText: z.string().default(
        [
          '可用命令（在窗口话题里发）：',
          '#stop 停止这个窗口',
          '#resume 把这个窗口恢复成进行中（底层会话还在才有用）',
          '#new 关掉当前窗口，下一条消息会开一个新窗口',
          '#新窗 另起一棵新话题再开一个窗口（本话题保持不动）',
          '#pin / #unpin 置顶或取消置顶状态卡',
          '#status 看这个窗口的状态',
          '#help 看这份说明',
          '其它内容都会当成话发给窗口。',
        ].join('\n'),
      ),
    })
    .strict(),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as {
    sources: string[]
    commands: string[]
    stopCommands: string[]
    newCommands: string[]
    helpCommands: string[]
    helpText: string
    resumeCommands: string[]
    attachCommands: string[]
    pinCommands: string[]
    unpinCommands: string[]
    resumeMax: number
    openOnMessage: boolean
    workspaceMax: number
  }

  ctx.on('message.received', async (e) => {
    const event = e.payload as Event
    // 所有分支（开窗向导与各条命令）都只认飞书来源：发送侧只有飞书频道，
    // 把钉钉的 chatId/messageId 当飞书 id 用会被平台拒掉。
    if (!cfg.sources.includes(event.source)) {
      ctx.log('info', `非飞书来源（${event.source}），控制台不处理：${event.id}`)
      return
    }
    const text = event.text.trim()
    const isStatus = cfg.commands.includes(text)
    const isStop = cfg.stopCommands.includes(text)
    const isNew = cfg.newCommands.includes(text)
    const isHelp = cfg.helpCommands.includes(text)
    const isResume = cfg.resumeCommands.includes(text)
    const isAttach = cfg.attachCommands.includes(text)
    const isPin = cfg.pinCommands.includes(text)
    const isUnpin = cfg.unpinCommands.includes(text)
    if (!isStatus && !isStop && !isNew && !isHelp && !isResume && !isAttach && !isPin && !isUnpin) {
      // 开窗向导第一步：未绑定的普通消息 = 「在这开个窗口」，正文当话题名。
      if (!cfg.openOnMessage || !ctx.has('state.session.route') || !ctx.has('notify.card.send')) return
      const bound = await ctx.call<Session | null>('state.session.route', {
        chatId: event.channel.id,
        threadId: event.threadId,
        rootId: event.rootId,
      })
      if (bound) return // 已绑话题的正文交给 session-post，不在这里抢
      const title = text.replace(/\s+/g, ' ').slice(0, 40) || '新窗口'
      ctx.log('info', `开窗向导：未绑定消息 ${event.id} → 发执行器卡（话题名「${title}」）`)
      await ctx.submit(
        'notify.card.send',
        {
          chatId: event.channel.id,
          replyTo: event.rootId ?? event.externalId,
          card: renderExecutorCard({
            chatId: event.channel.id,
            title,
            threadId: event.threadId,
            rootMessageId: event.rootId ?? event.externalId,
            source: event.source,
          }),
        },
        `open-exec:${event.id}`,
      )
      return
    }
    if (isAttach) {
      if (!ctx.has('state.session.live') || !ctx.has('notify.card.send') || !ctx.has('notify.reply')) {
        ctx.log('warn', '缺少 attach 所需能力，跳过')
        return
      }
      const live = await ctx.call<
        {
          executor: 'claude' | 'dsh'
          sessionId: string
          cwd: string
          title: string
          running: boolean
          status?: 'busy' | 'idle'
        }[]
      >('state.session.live', {})
      const pickable = live.filter((x) => x.running)
      if (!pickable.length) {
        await ctx.submit(
          'notify.reply',
          {
            target: { channel: 'feishu', chatId: event.channel.id, messageId: event.rootId ?? event.externalId },
            text: '现在没有正在跑的窗口可以接入。',
          },
          `attach-empty:${event.id}`,
        )
        return
      }
      const card = renderResumeCard({
        chatId: event.channel.id,
        threadId: event.threadId,
        rootMessageId: event.rootId ?? event.externalId,
        attach: true,
        items: pickable.slice(0, cfg.resumeMax).map((x) => ({
          label:
            `${(x.title || '（无标题）').slice(0, 24)} · ${x.executor}` +
            (x.status ? ` · ${x.status === 'busy' ? '在跑' : '空闲'}` : ''),
          sessionId: x.sessionId,
          cwd: x.cwd,
          executor: x.executor,
        })),
      })
      await ctx.submit(
        'notify.card.send',
        { chatId: event.channel.id, replyTo: event.rootId ?? event.externalId, card },
        `attach-pick:${event.id}`,
      )
      return
    }
    if (!ctx.has('state.session.route')) {
      ctx.log('warn', '缺少 state.session.route，跳过控制台命令')
      return
    }
    const session = await ctx.call<Session | null>('state.session.route', {
      chatId: event.channel.id,
      threadId: event.threadId,
    })
    // 与旧 Pipeline 一致：没绑定就不回（不猜、不刷屏）。
    if (!session) return
    if (isPin || isUnpin) {
      if (!ctx.has('notify.card.pin')) return
      await ctx.submit(
        'notify.card.pin',
        { sessionId: session.id, pin: isPin },
        `pin:${event.id}`,
      )
      return
    }
    if (isStop) {
      if (!ctx.has('session.stop')) {
        ctx.log('warn', '缺少 session.stop，跳过 #stop')
        return
      }
      await ctx.submit('session.stop', { sessionId: session.id }, `stop:${event.id}`)
      return
    }
    if (isNew) {
      if (!ctx.has('session.close') || !ctx.has('notify.reply')) {
        ctx.log('warn', '缺少 session.close / notify.reply，跳过 #new')
        return
      }
      await ctx.submit('session.close', { sessionId: session.id }, `close:${event.id}`)
      await ctx.submit(
        'notify.reply',
        {
          target: { channel: 'feishu', chatId: session.chatId, messageId: session.rootMessageId },
          text: '这个窗口已关闭。直接发一条新任务，就会开一个新窗口。',
        },
        `new-reply:${event.id}`,
      )
      return
    }
    if (isHelp) {
      if (!ctx.has('notify.reply')) return
      await ctx.submit(
        'notify.reply',
        {
          target: { channel: 'feishu', chatId: session.chatId, messageId: session.rootMessageId },
          text: cfg.helpText,
        },
        `help:${event.id}`,
      )
      return
    }
    if (isResume) {
      if (
        !ctx.has('state.workspace.get') ||
        !ctx.has('state.session.history') ||
        !ctx.has('notify.card.send') ||
        !ctx.has('notify.reply')
      ) {
        ctx.log('warn', '缺少 resume 所需能力，跳过')
        return
      }
      const ws = await ctx.call<{ root: string } | null>('state.workspace.get', { id: session.workspace })
      const say = async (text: string): Promise<void> => {
        await ctx.submit(
          'notify.reply',
          { target: { channel: 'feishu', chatId: session.chatId, messageId: session.rootMessageId }, text },
          `resume-reply:${event.id}`,
        )
      }
      if (!ws) return say('找不到这个窗口对应的工作区，无法列历史会话。')
      const all = await ctx.call<
        { executor: 'claude' | 'dsh'; sessionId: string; cwd: string; title: string; running: boolean }[]
      >('state.session.history', { cwd: ws.root, limit: cfg.resumeMax })
      const pickable = all.filter((x) => !x.running && x.sessionId !== session.sessionId)
      if (!pickable.length) return say('没有可恢复的历史会话。')
      const card = renderResumeCard({
        chatId: session.chatId,
        threadId: event.threadId,
        rootMessageId: session.rootMessageId,
        rebindSessionId: session.id,
        items: pickable.map((x) => ({
          label: `${(x.title || '（无标题）').slice(0, 24)} · ${x.executor}`,
          sessionId: x.sessionId,
          cwd: x.cwd,
          executor: x.executor,
        })),
      })
      await ctx.submit(
        'notify.card.send',
        { chatId: session.chatId, replyTo: session.rootMessageId, card },
        `resume-card:${event.id}`,
      )
      return
    }
    if (!ctx.has('notify.reply')) {
      ctx.log('warn', '缺少 notify.reply，跳过 #status')
      return
    }
    const reply = `窗口：${session.title ?? session.id}\n状态：${session.status}\n工作区：${session.workspace}\n执行器：${session.executor}`
    const r = await ctx.submit(
      'notify.reply',
      {
        target: { channel: 'feishu', chatId: session.chatId, messageId: session.rootMessageId },
        text: reply,
      },
      `status:${event.id}`,
    )
    ctx.log('info', `#status 回执 receipt=${r.receiptId} status=${r.status}`)
  })

  // 题卡只读回显：事件里只带 questionId，题目正文从能力读，避免事件载荷重复存储。
  ctx.on('session.ask.requested', async (e) => {
    const p = e.payload as { sessionId: string; questionId: string }
    if (!ctx.has('state.question.get') || !ctx.has('state.session.get') || !ctx.has('notify.reply')) return
    const q = await ctx.call<{ questions: { question: string }[] } | null>('state.question.get', { id: p.questionId })
    if (!q) return
    const session = await ctx.call<Session | null>('state.session.get', { sessionId: p.sessionId })
    if (!session) return
    const text = `待回答：\n${q.questions.map((x, i) => `${i + 1}. ${x.question}`).join('\n')}`
    await ctx.submit(
      'notify.reply',
      {
        target: { channel: 'feishu', chatId: session.chatId, messageId: session.rootMessageId },
        text,
      },
      `ask:${p.questionId}`,
    )
  })

  // 授权请求只读回显：工具名与入参原样带上，不在这里做批准/拒绝。
  ctx.on('session.permission.requested', async (e) => {
    const p = e.payload as { sessionId: string; toolName: string; toolInput?: unknown }
    if (!ctx.has('state.session.get') || !ctx.has('notify.reply')) return
    const session = await ctx.call<Session | null>('state.session.get', { sessionId: p.sessionId })
    if (!session) return
    const detail = p.toolInput === undefined ? '' : `\n${JSON.stringify(p.toolInput)}`
    await ctx.submit(
      'notify.reply',
      {
        target: { channel: 'feishu', chatId: session.chatId, messageId: session.rootMessageId },
        text: `待授权：${p.toolName}${detail}`,
      },
      `permission:${session.id}:${p.toolName}`,
    )
  })

  // 选择题卡片：只处理单选、单题；多选/多题仍由旧实现负责。
  ctx.on('card.action', async (e) => {
    const a = e.payload as CardAction
    if (a.action['k'] === 'exec') {
      const exec = a.action['exec'] === 'dsh' ? 'dsh' : 'claude'
      const prompt = typeof a.action['prompt'] === 'string' ? a.action['prompt'] : ''
      const thread = typeof a.action['thread'] === 'string' && a.action['thread'] ? a.action['thread'] : undefined
      const root = typeof a.action['root'] === 'string' ? a.action['root'] : ''
      const chat = typeof a.action['chat'] === 'string' ? a.action['chat'] : a.chatId
      const src = typeof a.action['src'] === 'string' && a.action['src'] ? a.action['src'] : ''
      if (!ctx.has('workspace.list') || !ctx.has('notify.card.send')) {
        ctx.log('warn', '缺少 workspace.list / notify.card.send，无法展开工作区')
        return
      }
      const ws = await ctx.call<{ root: string; label: string }[]>('workspace.list', { executor: exec })
      ctx.log('info', `开窗向导：选执行器 ${exec} → 工作区候选 ${ws.length} 个`)
      if (!ws.length) {
        await ctx.submit(
          'notify.card.send',
          {
            chatId: chat,
            replyTo: root || undefined,
            card: {
              config: { wide_screen_mode: true },
              header: { template: 'orange', title: { tag: 'plain_text', content: '没有可选工作区' } },
              elements: [
                {
                  tag: 'div',
                  text: {
                    tag: 'lark_md',
                    content: `执行器 ${exec} 的 allowRoots 下没有扫到工作区。先在配置里加一个允许根目录（executor_policies.${exec}.allowRoots）。`,
                  },
                },
              ],
            },
          },
          `open-ws-empty:${a.id}`,
        )
        return
      }
      await ctx.submit(
        'notify.card.send',
        {
          chatId: chat,
          replyTo: root || undefined,
          card: renderWorkspaceCard({
            chatId: chat,
            title: prompt || '新窗口',
            executor: exec,
            options: ws,
            threadId: thread,
            rootMessageId: root || undefined,
            max: cfg.workspaceMax,
            source: src,
          }),
        },
        `open-ws:${a.id}`,
      )
      return
    }
    if (a.action['k'] === 'pick') {
      const ws = typeof a.action['workspaceId'] === 'string' ? a.action['workspaceId'] : ''
      const exec = a.action['exec'] === 'dsh' ? 'dsh' : 'claude'
      const prompt = typeof a.action['prompt'] === 'string' ? a.action['prompt'] : ''
      const thread = typeof a.action['thread'] === 'string' && a.action['thread'] ? a.action['thread'] : undefined
      const root = typeof a.action['root'] === 'string' ? a.action['root'] : ''
      const chat = typeof a.action['chat'] === 'string' ? a.action['chat'] : a.chatId
      const src = typeof a.action['src'] === 'string' && a.action['src'] ? a.action['src'] : 'source-feishu-im'
      if (!ws || !chat || !ctx.has('session.open')) return
      const id = `open-${a.id}`
      // 选了工作区 = 用户信任这个目录：先登记，别让窗口第一次起来卡在「是否信任」确认框
      if (ctx.has('workspace.trust')) {
        const t = await ctx.call<{ trusted: boolean; changed: boolean }>('workspace.trust', { root: ws, executor: exec })
        if (t?.changed) ctx.log('info', `已把这个工作区加进信任目录：${ws}`)
        else if (t && !t.trusted) ctx.log('warn', `信任登记没成功：${ws}（第一次开窗可能要在电脑上点一次确认）`)
      }
      ctx.log('info', `开窗向导：选工作区 ${ws}（${exec}）→ 提交 session.open`)
      await ctx.submit(
        'session.open',
        {
          work: {
            id,
            intentId: id,
            kind: 'session',
            via: 'event',
            project: basename(ws),
            executor: exec,
            workspace: ws,
            prompt: prompt || '（新窗口，等你的第一条指令）',
            status: 'queued',
            origin: {
              chatId: chat,
              // 带上来源，session-result 才知道「结果回哪个渠道」
              source: src,
              title: prompt || basename(ws),
              threadId: thread,
              rootMessageId: root || undefined,
            },
          },
          // dsh 没有「预设 session id 开终端」的入口，只能后台会话
          mode: exec === 'claude' ? 'terminal' : 'headless',
        },
        `open-submit:${a.id}`,
      )
      return
    }
    if (a.action['k'] === 'attach') {
      if (!ctx.has('session.attach')) return
      const sid = typeof a.action['sid'] === 'string' ? a.action['sid'] : ''
      const cwd = typeof a.action['cwd'] === 'string' ? a.action['cwd'] : ''
      const exec = a.action['exec'] === 'dsh' ? 'dsh' : 'claude'
      const thread = typeof a.action['thread'] === 'string' && a.action['thread'] ? a.action['thread'] : undefined
      const root = typeof a.action['root'] === 'string' ? a.action['root'] : ''
      const chat = typeof a.action['chat'] === 'string' ? a.action['chat'] : a.chatId
      if (!sid || !cwd || !chat) return
      await ctx.submit(
        'session.attach',
        {
          chatId: chat,
          threadId: thread,
          rootMessageId: root || undefined,
          executorSessionId: sid,
          workspace: cwd,
          executor: exec,
        },
        `attach:${a.id}`,
      )
      return
    }
    if (a.action['k'] === 'resume') {
      if (!ctx.has('session.start')) return
      const sid = typeof a.action['sid'] === 'string' ? a.action['sid'] : ''
      const cwd = typeof a.action['cwd'] === 'string' ? a.action['cwd'] : ''
      const exec = a.action['exec'] === 'dsh' ? 'dsh' : 'claude'
      const rebind = typeof a.action['rebind'] === 'string' ? a.action['rebind'] : ''
      const thread = typeof a.action['thread'] === 'string' && a.action['thread'] ? a.action['thread'] : undefined
      const root = typeof a.action['root'] === 'string' ? a.action['root'] : ''
      const chat = typeof a.action['chat'] === 'string' ? a.action['chat'] : a.chatId
      if (!sid || !cwd) return
      await ctx.submit(
        'session.start',
        {
          work: {
            id: `resume-${a.id}`,
            intentId: `resume-${a.id}`,
            kind: 'session',
            project: basename(cwd),
            executor: exec,
            workspace: cwd,
            prompt: '（已恢复历史会话，等你的下一条指令）',
            resumeSessionId: sid,
            status: 'queued',
            origin: {
              chatId: chat,
              title: `恢复 ${basename(cwd)}`,
              threadId: thread,
              rootMessageId: root,
              rebindSessionId: rebind || undefined,
            },
          },
        },
        `resume-start:${a.id}`,
      )
      return
    }
    if (a.action['k'] !== 'ans') return
    const qid = typeof a.action['qid'] === 'string' ? a.action['qid'] : ''
    const label = typeof a.action['label'] === 'string' ? a.action['label'] : ''
    if (!qid || !label) return
    if (!ctx.has('state.question.get') || !ctx.has('session.answer')) return
    const q = await ctx.call<{ sessionId: string; questions: { question: string; multiSelect?: boolean }[] } | null>(
      'state.question.get',
      { id: qid },
    )
    if (!q || q.questions.length !== 1) return
    const target = q.questions[0]!
    if (target.multiSelect) return
    await ctx.submit(
      'session.answer',
      { sessionId: q.sessionId, questionId: qid, answers: { [target.question]: label } },
      `card-ans:${a.id}`,
    )
  })
}
