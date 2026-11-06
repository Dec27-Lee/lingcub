/**
 * 飞书文档待办能力（P4c-b，离线）：把纯逻辑暴露成能力，供场景/其他插件调用。
 * 命名受插件 slug 约束：id `scenario-feishu` → slug `feishu`，能力必须以 `feishu.` 开头。
 * 读文档正文/写回仍由后续 doc 执行层负责，这里不碰 lark-cli。
 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import { claimTodo, mergeTodos, parseTodos, splitTodo, type DocTodo } from '../../domain/doc-todos.ts'
import { runOnce } from '../../plugin-kit/spawn.ts'

const TodoOut = z.array(
  z.object({ id: z.string(), text: z.string(), done: z.boolean(), owner: z.string().optional() }),
)

export const manifest: ManifestV2 = {
  v: 2,
  id: 'scenario-feishu',
  roles: ['scenario'],
  provides: [
    { name: 'feishu.parse-todos', effect: 'none' },
    { name: 'feishu.claim-todo', effect: 'none' },
    { name: 'feishu.merge-todos', effect: 'none' },
    { name: 'feishu.split-todo', effect: 'none' },
    { name: 'feishu.read-doc', effect: 'none' },
  ],
  config: z
    .object({
      binary: z.string().default('lark-cli'),
      readArgs: z.array(z.string()).default(['doc', 'read', '{{url}}', '--format', 'markdown']),
    })
    .strict(),
}

export function setup(ctx: PluginContextV2): void {
  ctx.provide(
    'feishu.parse-todos',
    { input: z.object({ markdown: z.string() }), output: TodoOut },
    (input) => parseTodos(input.markdown),
  )

  ctx.provide(
    'feishu.claim-todo',
    {
      input: z.object({
        items: TodoOut,
        id: z.string().min(1),
        owner: z.string().min(1),
      }),
      output: z.object({
        items: TodoOut,
        ok: z.boolean(),
        reason: z.enum(['missing', 'done', 'taken']).optional(),
      }),
    },
    (input) => claimTodo(input.items as DocTodo[], input.id, input.owner),
  )

  ctx.provide(
    'feishu.merge-todos',
    {
      input: z.object({ existing: TodoOut, incoming: TodoOut }),
      output: TodoOut,
    },
    (input) => mergeTodos(input.existing as DocTodo[], input.incoming as DocTodo[]),
  )

  ctx.provide(
    'feishu.split-todo',
    {
      input: z.object({ text: z.string().min(1), maxLen: z.number().int().positive().default(120) }),
      output: z.array(z.string()),
    },
    (input) => splitTodo(input.text, input.maxLen ?? 120),
  )

  // 读正文：命令模板来自配置，凭据由 lark-cli 自己管；退出码非 0 一律失败，不猜。
  ctx.provide(
    'feishu.read-doc',
    { input: z.object({ url: z.string().min(1) }), output: z.object({ markdown: z.string() }) },
    async (input) => {
      const cfg = ctx.config as { binary: string; readArgs: string[] }
      const args = cfg.readArgs.map((a) => a.replaceAll('{{url}}', input.url))
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: 15_000 })
      if (r.code !== 0) {
        throw new Error(`读文档失败（exit=${r.code ?? 'null'}）：${r.stderr.slice(0, 200)}`)
      }
      return { markdown: r.stdout }
    },
  )
}

