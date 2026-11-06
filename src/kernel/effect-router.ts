/** 能力提交 → 发件箱 Action 的唯一路由。内核与测试共用，避免两套映射漂移。 */

import type { Action, CardState, Event, Intent, Work } from '../domain/types.ts'
import { resolveWork } from '../routing/resolve.ts'
import type { EnqueueEffect } from './capabilities.ts'
import type { Config, Projects } from './config.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export function createEffectRouter(deps: {
  store: Store
  outbox: Outbox
  config: Config
  projects: Projects
}): EnqueueEffect {
  const { store, outbox, config, projects } = deps
  let currentEventId: string | undefined
  const enqueue = (action: Action, opKey: string, name: string): { outboxId?: number } | undefined => {
    outbox.enqueue(action, opKey, { eventId: currentEventId })
    const id = store.outboxIdByDedupeKey(opKey)
    if (id === null) throw new Error(`能力 ${name} 入队后取不到 outboxId：${opKey}`)
    return { outboxId: id }
  }

  return (e) => {
    currentEventId = e.eventId
    if (e.name === 'notify.reply') {
      const p = e.payload as {
        target: { channel: string; chatId: string; messageId?: string }
        text: string
      }
      if (p.target.channel !== 'feishu') throw new Error(`notify.reply 目前只支持飞书：${p.target.channel}`)
      return enqueue(
        { kind: 'reply_only', text: p.text, chatId: p.target.chatId, replyTo: p.target.messageId },
        e.opKey,
        e.name,
      )
    }
    if (e.name === 'task.open') {
      const p = e.payload as {
        event: Event
        intent: Intent
        dispatch?: boolean
        via?: 'pipeline' | 'event'
        mode?: 'terminal' | 'headless'
      }
      // events 表只留最小字段（threadId/rootId 不进库），来源信息用入参里的完整事件。
      if (!store.getEvent(p.event.id)) throw new Error(`task.open 的事件不在 events 里：${p.event.id}`)
      const resolved = resolveWork(p.intent, p.event, { config, projects })
      if (resolved.kind !== 'work') {
        throw new Error(`task.open 未派工：${resolved.kind === 'observe' ? 'observe 档' : resolved.reason}`)
      }
      store.insertIntent(p.intent)
      const storedWork = p.via === 'event' ? { ...resolved.work, via: 'event' as const } : resolved.work
      store.insertWork(storedWork)
      const work: Work = {
        ...storedWork,
        ownerId: p.event.actor.id,
        origin: {
          chatId: p.event.channel.id,
          source: p.event.source,
          title: p.intent.topic,
          threadId: p.event.threadId ?? p.event.channel.id,
          rootMessageId: p.event.rootId ?? p.event.externalId,
        },
      }
      if (p.via === 'event') {
        return enqueue({ kind: 'open_session', work, mode: p.mode ?? 'terminal' }, e.opKey, e.name)
      }
      return enqueue({ kind: p.dispatch ? 'dispatch_session' : 'start_session', work }, e.opKey, e.name)
    }
    if (e.name === 'session.dispatch') {
      const p = e.payload as { work: Work }
      return enqueue({ kind: 'dispatch_session', work: p.work }, e.opKey, e.name)
    }
    if (e.name === 'session.start') {
      const p = e.payload as { work: Work }
      return enqueue({ kind: 'start_session', work: p.work }, e.opKey, e.name)
    }
    if (e.name === 'session.open') {
      const p = e.payload as { work: Work; mode: 'terminal' | 'headless' }
      return enqueue({ kind: 'open_session', work: p.work, mode: p.mode }, e.opKey, e.name)
    }
    if (e.name === 'session.close') {
      const p = e.payload as { sessionId: string }
      return enqueue({ kind: 'stop_session', sessionId: p.sessionId, keepExecutor: true }, e.opKey, e.name)
    }
    if (e.name === 'doc.write') {
      const p = e.payload as { doc: string; heading: string; body: string; revision: string; fingerprint: string }
      return enqueue(
        {
          kind: 'update_doc',
          doc: p.doc,
          heading: p.heading,
          body: p.body,
          expect: { revision: p.revision, fingerprint: p.fingerprint },
        },
        e.opKey,
        e.name,
      )
    }
    if (e.name === 'session.answer') {
      const p = e.payload as { sessionId: string; questionId: string; answers: Record<string, string> }
      return enqueue(
        { kind: 'answer_question', sessionId: p.sessionId, questionId: p.questionId, answers: p.answers },
        e.opKey,
        e.name,
      )
    }
    if (e.name === 'session.post') {
      const p = e.payload as { sessionId: string; text: string }
      return enqueue({ kind: 'post_message', sessionId: p.sessionId, text: p.text }, e.opKey, e.name)
    }
    if (e.name === 'session.stop') {
      const p = e.payload as { sessionId: string }
      return enqueue({ kind: 'stop_session', sessionId: p.sessionId }, e.opKey, e.name)
    }
    if (e.name === 'session.attach') {
      const p = e.payload as {
        chatId: string
        threadId?: string
        rootMessageId?: string
        executorSessionId: string
        workspace: string
        executor: 'claude' | 'dsh'
      }
      return enqueue(
        {
          kind: 'attach_session',
          chatId: p.chatId,
          threadId: p.threadId,
          rootMessageId: p.rootMessageId,
          executorSessionId: p.executorSessionId,
          workspace: p.workspace,
          executor: p.executor,
        },
        e.opKey,
        e.name,
      )
    }
    if (e.name === 'session.bind') {
      const p = e.payload as { sessionId: string; executorSessionId: string; workspace: string }
      return enqueue(
        {
          kind: 'rebind_session',
          sessionId: p.sessionId,
          executorSessionId: p.executorSessionId,
          workspace: p.workspace,
        },
        e.opKey,
        e.name,
      )
    }
    if (e.name === 'notify.card.send') {
      const p = e.payload as {
        chatId: string
        channel?: string
        replyTo?: string
        card: unknown
        sessionId?: string
      }
      return enqueue(
        {
          kind: 'card_send',
          chatId: p.chatId,
          channel: p.channel,
          replyTo: p.replyTo,
          card: p.card,
          sessionId: p.sessionId,
          pin: (p as { pin?: boolean }).pin === true,
        },
        e.opKey,
        e.name,
      )
    }
    if (e.name === 'notify.card.patch') {
      const p = e.payload as { chatId: string; messageId: string; card: unknown }
      return enqueue({ kind: 'card_patch', chatId: p.chatId, messageId: p.messageId, card: p.card }, e.opKey, e.name)
    }
    if (e.name === 'notify.dm.send') {
      const p = e.payload as { userId: string; card: unknown }
      return enqueue({ kind: 'dm_send', userId: p.userId, card: p.card }, e.opKey, e.name)
    }
    if (e.name === 'notify.card.upsert') {
      const p = e.payload as { sessionId: string; card: unknown; signature: string }
      return enqueue(
        { kind: 'card_upsert', sessionId: p.sessionId, card: p.card as CardState, signature: p.signature },
        e.opKey,
        e.name,
      )
    }
    if (e.name === 'notify.card.pin') {
      const p = e.payload as { sessionId: string; pin: boolean }
      return enqueue({ kind: 'pin_card', sessionId: p.sessionId, pin: p.pin }, e.opKey, e.name)
    }
    if (e.name.startsWith('transport.')) {
      const p = e.payload as { target: Record<string, string>; text: string }
      return enqueue({ kind: 'transport_send', plugin: e.provider, target: p.target, text: p.text }, e.opKey, e.name)
    }
    throw new Error(`能力 ${e.name} 没有副作用路由`)
  }
}
