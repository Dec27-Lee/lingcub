import * as classifier from './src/plugins/classifier-llm/index.ts'
import type { Classifier } from './src/domain/ports.ts'

const c = classifier.manifest.config.parse({
  binary: 'claude',
  args: ['-p'],
  prompt: 'prompts/classify.md',
  minConfidence: 0.3,
  timeoutMs: 120_000,
})
const impl = (() => {
  let captured: Classifier | null = null
  classifier.setup({
    config: c,
    log: (l: string, m: string) => process.stdout.write(`[${l}] ${m}\n`),
    register: (x: Classifier) => {
      captured = x
    },
  } as never)
  return captured!
})()

const e = {
  id: 'x',
  source: 'source-feishu-im',
  externalId: 'om_x100b61a830c06ca4c0cdcf675777c83',
  receivedAt: new Date().toISOString(),
  occurredAt: new Date().toISOString(),
  actor: { id: 'ou_37acf2c3089764fd8bd68b447251a293' },
  channel: { kind: 'group', id: 'oc_20fef3ba28ef35cfc2d86f0b51d20348' },
  text: '把导出按钮加上，点一下导出成 xlsx',
}
const intent = await impl.classify(e as never, [
  { id: 'tt-design-space', name: '公司 · 天通设计空间', aliases: ['tt', '设计空间'] },
  { id: 'personal-lingcub', name: '个人 · 幺幺零', aliases: ['lingcub'] },
] as never)
process.stdout.write('intent=' + JSON.stringify(intent) + '\n')
