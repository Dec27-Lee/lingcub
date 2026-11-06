/**
 * 文档待办场景：列待办、认领一条并写回。
 *
 * 只依赖内核能力（文档快照/写回、回执）与纯函数；飞书/钉钉文档差异由 DocPort 插件吸收。
 */

import { z } from 'zod'
import { claimTodo, parseTodos, renderTodos, type DocTodo } from '../../domain/doc-todos.ts'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { Event } from '../../domain/types.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-doc-todos',
  roles: ['scenario'],
  provides: [],
  needs: ['state.doc.snapshot', 'doc.write', 'notify.reply'],
  wants: [],
  on: ['message.received'],
  owns: ['messages'],
  config: z
    .object({
      listCommands: z.array(z.string()).default(['#待办', '#todos']),
      claimCommands: z.array(z.string()).default(['#认领', '#claim']),
    })
    .strict(),
}

function render(items: DocTodo[]): string {
  if (!items.length) return '文档里没有待办。'
  return items
    .map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text}${t.owner ? `（${t.owner}）` : ''}`)
    .join('\n')
}

const bodyOf = (items: DocTodo[]): string => renderTodos(items)

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as { listCommands: string[]; claimCommands: string[] }
  const reply = async (e: Event, text: string): Promise<void> => {
    await ctx.submit(
      'notify.reply',
      { target: { channel: 'feishu', chatId: e.channel.id, messageId: e.rootId ?? e.externalId }, text },
      `todos:${e.id}`,
    )
  }
  const snapshot = (doc: string) =>
    ctx.call<{ markdown: string; revision: string }>('state.doc.snapshot', { doc })

  ctx.on('message.received', async (e) => {
    const event = e.payload as Event
    const text = (event.text ?? '').trim()
    const [cmd, ...rest] = text.split(/\s+/)
    if (!cmd) return

    if (cfg.listCommands.includes(cmd)) {
      const doc = rest[0]
      if (!doc) return reply(event, '用法：#待办 <文档链接或 id>')
      const snap = await snapshot(doc)
      return reply(event, render(parseTodos(snap.markdown)))
    }

    if (cfg.claimCommands.includes(cmd)) {
      const [doc, heading, rawIndex] = rest
      const index = Number(rawIndex)
      if (!doc || !heading || !Number.isInteger(index) || index < 1) {
        return reply(event, '用法：#认领 <文档链接> <小节标题> <序号>')
      }
      const snap = await snapshot(doc)
      const parsed = parseTodos(snap.markdown)
      const target = parsed[index - 1]
      if (!target) return reply(event, `序号超出范围（共 ${parsed.length} 条）。`)
      const owner = event.actor.name || event.actor.id
      const claimed = claimTodo(parsed, target.id, owner)
      if (!claimed.ok) {
        const why = { missing: '这条待办不见了', done: '这条已完成', taken: '已被别人认领' }[claimed.reason ?? 'missing']
        return reply(event, `没认领：${why}。`)
      }
      await ctx.submit(
        'doc.write',
        {
          doc,
          heading,
          body: bodyOf(claimed.items as DocTodo[]),
          revision: snap.revision,
          fingerprint: `todos:${target.id}`,
        },
        `claim:${e.id}`,
      )
      return reply(event, `已认领第 ${index} 条，写回「${heading}」。`)
    }
  })
}



