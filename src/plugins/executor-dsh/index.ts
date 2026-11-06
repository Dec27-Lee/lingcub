/** dsh 执行器（v1 端口）：headless NDJSON；共享实现见 plugin-kit。 */

import type { PluginContext } from '../../domain/ports.ts'
import { createDshExecutor, dshConfigSchema } from '../../plugin-kit/dsh-executor.ts'

export const manifest = {
  id: 'executor-dsh',
  kind: 'executor' as const,
  config: dshConfigSchema,
}

export function setup(ctx: PluginContext<typeof manifest>): void {
  ctx.register(createDshExecutor(ctx.config, ctx.log))
}
