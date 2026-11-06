import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as docTodos from '../src/plugins/scenario-doc-todos/index.ts'

const silent = (): void => {}

function mount() {
  let handler: ((e: { payload: unknown }) => Promise<void>) | undefined
  const submitted: { name: string; input: unknown }[] = []
  const ctx = {
    config: docTodos.manifest.config.parse({}),
    has: () => true,
    log: silent,
    on: (_kind: string, fn: never) => {
      handler = fn
    },
    call: async (name: string) => {
      if (name === 'state.doc.snapshot') {
        return { revision: 'r1', markdown: '# 待办\n- [ ] [t1] 修复登录\n- [ ] [t2] 补测试\n' }
      }
      return null
    },
    submit: async (name: string, input: unknown) => {
      submitted.push({ name, input })
      return { receiptId: 1, status: 'submitted' }
    },
  }
  docTodos.setup(ctx as never)
  const run = async (text: string): Promise<void> => {
    assert.ok(handler)
    await handler({
      payload: {
        id: `ev-${text}`,
        source: 'feishu',
        externalId: 'om1',
        receivedAt: '2026-11-04T00:00:00Z',
        occurredAt: '2026-11-04T00:00:00Z',
        actor: { id: 'u1', name: 'Yue' },
        channel: { kind: 'group', id: 'oc_1' },
        text,
        raw: {},
        threadId: 'th_1',
        rootId: 'om_root',
      },
    })
  }
  return { run, submitted }
}

test('#待办：读快照并列出待办', async () => {
  const m = mount()
  await m.run('#待办 https://example.com/docx/abc')
  const reply = m.submitted.find((s) => s.name === 'notify.reply')?.input as { text: string }
  assert.match(reply.text, /1\. \[ \] 修复登录/)
  assert.match(reply.text, /2\. \[ \] 补测试/)
})

test('#认领：认领第一条并写回，带 revision', async () => {
  const m = mount()
  await m.run('#认领 https://example.com/docx/abc 待办 1')
  const write = m.submitted.find((s) => s.name === 'doc.write')?.input as {
    heading: string
    body: string
    revision: string
  }
  assert.equal(write.heading, '待办')
  assert.equal(write.revision, 'r1')
  assert.match(write.body, /- \[ \] \[t1\] 修复登录 \[Yue\]/)
  const reply = m.submitted.find((s) => s.name === 'notify.reply')?.input as { text: string }
  assert.match(reply.text, /已认领第 1 条/)
})
