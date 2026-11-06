import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDingTalkSent } from '../src/plugin-kit/dingtalk-source.ts'
import type { Event } from '../src/domain/types.ts'

const silent = (): void => {}

test('钉钉出站来源：历史里只保留 senderId=self，映射成 dm 事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-dingtalk-sent-'))
  const script = join(dir, 'fake.mjs')
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({result:{conversationMessagesList:[{messages:[
      {messageId:'self-1',openConversationId:'cid-1',createTime:'2026-11-05 16:40:00',sender:'我',senderId:'me',text:'我发的',singleChat:true},
      {messageId:'other-1',openConversationId:'cid-1',createTime:'2026-11-05 16:41:00',sender:'别人',senderId:'other',text:'别人发的',singleChat:true}
    ]}]}}))\n`,
    'utf8',
  )
  const source = createDingTalkSent({
    source: 'source-dingtalk-sent',
    binary: process.execPath,
    args: [script, '--start', '{{start}}', '--end', '{{end}}'],
    selfId: 'me',
    fields: {
      externalId: 'messageId',
      text: 'text',
      channelId: 'openConversationId',
      actorId: 'senderId',
      occurredAt: 'createTime',
      actorName: 'sender',
    },
    intervalMs: 3_600_000,
    lookbackMinutes: 10,
    log: silent,
  })
  const seen: Event[] = []
  await source.start((e) => seen.push(e))
  await source.stop()
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.externalId, 'self-1')
  assert.equal(seen[0]?.text, '我发的')
  assert.equal(seen[0]?.channel.kind, 'dm')
  assert.equal(seen[0]?.source, 'source-dingtalk-sent')
})
