/** claude 执行器（v1 端口）：后台 `claude --bg` 会话；共享实现见 plugin-kit。 */

import type { PluginContext } from '../../domain/ports.ts'
import { claudeConfigSchema, createClaudeExecutor } from '../../plugin-kit/claude-executor.ts'

export const manifest = {
  id: 'executor-claude',
  kind: 'executor' as const,
  config: claudeConfigSchema,
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  ctx.register(createClaudeExecutor(ctx.config, ctx.log))
}
