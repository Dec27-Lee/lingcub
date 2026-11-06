/** 内存文档端口（测试/离线用）：实现 DocPort，不做任何平台调用。 */

import { z } from 'zod'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'

export const manifest: ManifestV2 = {
  v: 2,
  id: 'capability-doc-memory',
  roles: ['doc'],
  config: z
    .object({
      markdown: z.string().default(''),
      revision: z.string().default('r1'),
    })
    .strict(),
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as { markdown: string; revision: string }
  let markdown = cfg.markdown
  let revision = cfg.revision

  ctx.registerPort({
    async read(): Promise<{ revision: string; markdown: string }> {
      return { revision, markdown }
    },
    async write(_doc: string, next: string, expect: { revision: string }): Promise<{ revision: string }> {
      // 端口层再兜一次版本检查：调用方绕过内核直接写时也不会覆盖新版本。
      if (expect.revision !== revision) throw new Error(`文档版本冲突：${expect.revision} != ${revision}`)
      markdown = next
      revision = `r${Number(revision.replace(/^r/, '')) + 1 || 2}`
      return { revision }
    },
  })
}

