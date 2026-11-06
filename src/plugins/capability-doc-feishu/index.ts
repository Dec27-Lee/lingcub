/**
 * 飞书 docx 文档插件（v2 的 doc 端口）：只按小节做 block_replace，不整篇覆盖。
 * 平台事实见 docs/006：块 id 只能从 xml 取（markdown + with-ids 拿不到），block_replace 是同父闭区间，
 * revision_id 是数字；正文本体走 stdin（多行内容不塞命令行）。
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { findSection, renderSectionXml } from '../../domain/doc-xml.ts'
import type { ManifestV2, PluginContextV2 } from '../../domain/plugin-v2.ts'
import type { DocPort } from '../../domain/ports.ts'
import { extractJson } from '../../plugin-kit/json.ts'
import { runOnce } from '../../plugin-kit/spawn.ts'
import { assertNoPlaceholders, renderArgs } from '../../plugin-kit/template.ts'

const ConfigSchema = z
  .object({
    binary: z.string().default('lark-cli'),
    readArgs: z.array(z.string()).default([
      'docs',
      '+fetch',
      '--as',
      'user',
      '--doc',
      '{{doc}}',
      '--scope',
      'full',
      '--doc-format',
      'markdown',
      '--revision-id',
      '-1',
    ]),
    /** 取块 id 必须 xml + with-ids；markdown 下拿不到 block id（docs/006） */
    fetchXmlArgs: z.array(z.string()).default([
      'docs',
      '+fetch',
      '--as',
      'user',
      '--doc',
      '{{doc}}',
      '--scope',
      'full',
      '--doc-format',
      'xml',
      '--detail',
      'with-ids',
      '--revision-id',
      '-1',
    ]),
    writeArgs: z.array(z.string()).default([
      'docs',
      '+update',
      '--as',
      'user',
      '--doc',
      '{{doc}}',
      '--command',
      'block_replace',
      '--start-block-id',
      '{{startId}}',
      '--end-block-id',
      '{{endId}}',
      '--doc-format',
      'xml',
      '--revision-id',
      '{{revision}}',
      '--content',
      '-',
    ]),
    timeoutMs: z.number().int().positive().default(120_000),
  })
  .strict()

type Config = z.infer<typeof ConfigSchema>

export const manifest: ManifestV2 = {
  v: 2,
  id: 'capability-doc-feishu',
  roles: ['doc'],
  config: ConfigSchema,
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function tail(text: string, max = 400): string {
  const t = text.trim()
  return t.length > max ? `…${t.slice(-max)}` : t
}

function objectOf(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** 信封里的 `data.document`（lark-cli 的读/写回执形状）。 */
function documentOf(parsed: unknown): Record<string, unknown> | undefined {
  return objectOf(objectOf(parsed)?.data)?.document as Record<string, unknown> | undefined
}

/** 成功判据是 exit 0 或 `ok == true`；exit 0 但 ok=false 也算失败，不能当成功继续写。 */
function envelopeError(parsed: unknown): string | undefined {
  const env = objectOf(parsed)
  if (!env || env.ok !== false) return undefined
  const err = objectOf(env.error)
  const message = typeof err?.message === 'string' && err.message ? err.message : 'ok=false'
  return message
}

/** 正文：xml / markdown 两种取法字段名不同，统一按 content → markdown → xml → text 找。 */
function bodyOf(parsed: unknown): string | undefined {
  const candidates = [documentOf(parsed), objectOf(objectOf(parsed)?.data), objectOf(parsed)]
  for (const source of candidates) {
    if (!source) continue
    for (const key of ['content', 'markdown', 'xml', 'text']) {
      const v = source[key]
      if (typeof v === 'string' && v.trim()) return v
    }
  }
  return undefined
}

/** revision_id 是数字；缺失时回退正文指纹，至少能保证「内容没变就不写」。 */
function revisionOf(parsed: unknown, fallback: string): string {
  const rev = documentOf(parsed)?.revision_id
  if (typeof rev === 'number') return String(rev)
  if (typeof rev === 'string' && rev.trim()) return rev.trim()
  return sha256(fallback)
}

export function setup(ctx: PluginContextV2): void {
  const cfg = ctx.config as Config

  const port: DocPort = {
    async read(doc: string): Promise<{ revision: string; markdown: string }> {
      const args = renderArgs(cfg.readArgs, { doc })
      assertNoPlaceholders(args)
      const r = await runOnce({ binary: cfg.binary, args, timeoutMs: cfg.timeoutMs })
      if (r.code !== 0) throw new Error(`飞书文档读取失败（code=${r.code}）：${tail(r.stderr || r.stdout)}`)
      const parsed = extractJson(r.stdout)
      const failed = envelopeError(parsed)
      if (failed) throw new Error(`飞书文档读取失败：${failed}`)
      const markdown = bodyOf(parsed)
      if (markdown === undefined) throw new Error(`飞书文档读取结果里没有正文：${tail(r.stdout)}`)
      return { revision: revisionOf(parsed, markdown), markdown }
    },

    async write(): Promise<{ revision: string }> {
      // docx 整篇覆盖会丢评论/资源，平台也可能落到 Drive 原生 md 而不是 docx（docs/006）
      throw new Error('不支持整篇覆盖：飞书 docx 只能按小节写回（writeSection）')
    },

    async writeSection(
      doc: string,
      heading: string,
      body: string,
      expect: { revision: string },
    ): Promise<{ revision: string }> {
      const fetchArgs = renderArgs(cfg.fetchXmlArgs, { doc })
      assertNoPlaceholders(fetchArgs)
      const f = await runOnce({ binary: cfg.binary, args: fetchArgs, timeoutMs: cfg.timeoutMs })
      if (f.code !== 0) throw new Error(`飞书文档读取 XML 失败（code=${f.code}）：${tail(f.stderr || f.stdout)}`)
      const fetched = extractJson(f.stdout)
      const failed = envelopeError(fetched)
      if (failed) throw new Error(`飞书文档读取 XML 失败：${failed}`)
      const xml = bodyOf(fetched)
      if (xml === undefined || !xml.includes('<')) {
        throw new Error(`飞书文档读取结果里没有 XML：${tail(f.stdout)}`)
      }
      const revision = revisionOf(fetched, xml)
      if (revision !== expect.revision) {
        throw new Error(`文档版本冲突：期望 ${expect.revision}，实际 ${revision}`)
      }
      const section = findSection(xml, heading)
      if (!section) throw new Error(`文档里找不到小节：${heading}`)
      const content = renderSectionXml(heading, body, section.level)

      const writeArgs = renderArgs(cfg.writeArgs, {
        doc,
        startId: section.headingId,
        endId: section.endId,
        revision,
      })
      assertNoPlaceholders(writeArgs)
      const w = await runOnce({ binary: cfg.binary, args: writeArgs, input: content, timeoutMs: cfg.timeoutMs })
      if (w.code !== 0) throw new Error(`飞书文档写回失败（code=${w.code}）：${tail(w.stderr || w.stdout)}`)
      const updated = extractJson(w.stdout)
      const failedWrite = envelopeError(updated)
      if (failedWrite) throw new Error(`飞书文档写回失败：${failedWrite}`)
      return { revision: revisionOf(updated, content) }
    },
  }

  ctx.registerPort(port)
}
