import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractJson } from '../../../src/plugin-kit/json.ts'

test('extractJson：lark-cli 的缩进 JSON 按整段解析', () => {
  const pretty = '{\n  "ok": true,\n  "data": {\n    "document": { "revision_id": 17, "content": "<p>x</p>" }\n  }\n}\n'
  const parsed = extractJson(pretty) as { ok: boolean; data: { document: { revision_id: number } } }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.document.revision_id, 17)
})

test('extractJson：NDJSON 仍取最后一个事件', () => {
  const parsed = extractJson('{"type":"a"}\n{"type":"b","text":"done"}\n') as { type: string }
  assert.equal(parsed.type, 'b')
})
