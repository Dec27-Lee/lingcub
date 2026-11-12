import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { contentText, lastDshTurn, lastFinishedTurn, readDshRecords, splitZstdFrames } from '../../../src/kernel/dsh-transcript.ts'
import type { DshRecord } from '../../../src/kernel/dsh-transcript.ts'

/** dsh 写的是**多帧拼接**的 zstd：一帧一段 JSONL，追加写入。 */
function framesFile(records: DshRecord[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dshtx-'))
  const p = join(dir, 'session.v4.jsonl.zstd')
  const parts: Buffer[] = []
  for (const frame of records) {
    const text = frame.map((r) => JSON.stringify(r)).join('\n') + '\n'
    parts.push(zstdCompressSync(Buffer.from(text, 'utf8')))
  }
  writeFileSync(p, Buffer.concat(parts))
  return p
}

const turnStart = (turn: number, seq: number): DshRecord => ({ type: 'turn/start', seq, data: { turn } })
const userMsg = (turn: number, seq: number, text: string): DshRecord => ({
  type: 'user/message',
  seq,
  data: { turn, message: { role: 'user', content: [{ type: 'text', text }] } },
})
const assistant = (turn: number, seq: number, blocks: unknown[]): DshRecord => ({
  type: 'assistant/message',
  seq,
  data: { turn, message: { role: 'assistant', content: blocks } },
})
const turnEnd = (turn: number, seq: number, time: number): DshRecord => ({ type: 'turn/end', seq, time, data: { turn } })

test('多帧 zstd 按帧魔数切开，逐帧解压后拿到全部记录', () => {
  const file = framesFile([
    [turnStart(1, 1)],
    [userMsg(1, 2, '把导出按钮加上')],
    [assistant(1, 3, [{ type: 'text', text: '改好了' }]), turnEnd(1, 4, 1_700_000_000_000)],
  ])
  const records = readDshRecords(file)
  assert.ok(records, '要能读到记录')
  // Node 的 zstdDecompressSync 直接解这个文件只出第一帧；能拿到 4 条就说明逐帧解成功
  assert.deepEqual(
    records!.map((r) => r.type),
    ['turn/start', 'user/message', 'assistant/message', 'turn/end'],
  )
  assert.equal(splitZstdFrames(Buffer.concat([zstdCompressSync(Buffer.from('a')), zstdCompressSync(Buffer.from('b'))])).length, 2)
})

test('正文只取 text 块：reasoning 与工具调用都不能发出去', () => {
  assert.equal(
    contentText([
      { type: 'reasoning', text: '我先想想' },
      { type: 'text', text: '插件页签改完了' },
      { type: 'tool-call', name: 'read', arguments: '{}' },
      { type: 'text', text: '可以刷新看。' },
    ]),
    '插件页签改完了\n可以刷新看。',
  )
  assert.equal(contentText('纯字符串正文'), '纯字符串正文')
  assert.equal(contentText(undefined), '')
})

test('取最后一个已结束的轮次：末轮没跑完就不算', () => {
  const file = framesFile([
    [turnStart(1, 1), userMsg(1, 2, '第一轮'), assistant(1, 3, [{ type: 'text', text: '第一轮答复' }]), turnEnd(1, 4, 1_700_000_001_000)],
    [turnStart(2, 5), userMsg(2, 6, '第二轮'), assistant(2, 7, [{ type: 'reasoning', text: '嗯' }, { type: 'text', text: '第二轮答复' }]), turnEnd(2, 8, 1_700_000_002_000)],
    [turnStart(3, 9), userMsg(3, 10, '第三轮还没完')],
  ])
  const turn = lastDshTurn(file)
  assert.ok(turn, '要取到已结束的那一轮')
  assert.equal(turn!.id, '8', '判重 id 用 turn/end 的 seq')
  assert.equal(turn!.text, '第二轮答复')
  assert.equal(turn!.said, '第二轮')
  assert.equal(turn!.endedAt, 1_700_000_002_000)
})

test('一轮都没有结束时返回 null（不能把半成品当结果发出去）', () => {
  const records: DshRecord[] = [turnStart(1, 1), userMsg(1, 2, '在吗'), assistant(1, 3, [{ type: 'text', text: '在' }])]
  assert.equal(lastFinishedTurn(records), null)
})

test('只有 reasoning 没有正文的轮次不发（否则会把思考过程发到群里）', () => {
  const records: DshRecord[] = [
    turnStart(1, 1),
    assistant(1, 2, [{ type: 'reasoning', text: '想想' }]),
    turnEnd(1, 3, 1_700_000_000_000),
  ]
  assert.equal(lastFinishedTurn(records), null)
})

test('文件不存在时返回 undefined / null，不抛错', () => {
  assert.equal(readDshRecords(join(tmpdir(), 'lingcub-no-such-dsh.jsonl.zstd')), undefined)
  assert.equal(lastDshTurn(join(tmpdir(), 'lingcub-no-such-dsh.jsonl.zstd')), null)
})
