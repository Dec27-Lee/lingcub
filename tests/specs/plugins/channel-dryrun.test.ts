import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { manifest, setup } from '../../../src/plugins/channel-feishu/index.ts'
import type { Channel } from '../../../src/domain/ports.ts'

/** 拿一个装了 dryRun 的频道插件；日志收在数组里方便断言。 */
function dryChannel(extra: Record<string, unknown> = {}) {
  const logs: string[] = []
  let registered: Channel | null = null
  setup({
    config: {
      ...manifest.config.parse({ dryRun: true }),
      defaultChatId: 'oc_1',
      ...extra,
    },
    log: (level: string, msg: string) => logs.push(`${level}:${msg}`),
    register: (c: Channel) => {
      registered = c
    },
    root: mkdtempSync(join(tmpdir(), 'lingcub-dry-')),
  } as never)
  return { channel: registered as unknown as Channel, logs }
}

test('预演：发文本只记命令行，不真调 CLI', async () => {
  const { channel, logs } = dryChannel()
  const r = await channel.send(
    { kind: 'reply_only', chatId: 'oc_1', replyTo: 'om_root', text: '分页改好了' },
    'k1',
  )
  assert.equal(r.status, 'sent')
  assert.match(String(r.messageId), /^om_dry_/, '预演也要回一个假 id，否则链路断在绑定上')
  const line = logs.find((l) => l.includes('[预演] 发文本'))!
  assert.ok(line, '要记一行预演日志')
  assert.ok(line.includes('+messages-reply'), '要能看出用的是「话题内回复」这条命令')
  assert.ok(line.includes('--reply-in-thread'), '话题内回复必须带这个参数')
  assert.ok(line.includes('分页改好了'), '正文要出现在命令行里，才看得清发什么')
})

test('预演：发卡/改卡/置顶/下载图片都只记命令行', async () => {
  const { channel, logs } = dryChannel({ pinCards: true })
  const sent = await channel.sendCard({
    chatId: 'oc_1',
    replyTo: 'om_root',
    card: { title: 't', status: 'running', lines: ['📁 x'] },
  }, 'k2')
  assert.match(String(sent.messageId), /^om_dry_/)

  await channel.patchCard('om_x', { title: 't', status: 'done', lines: ['⚪ 结束'] })
  await channel.pinMessage?.('om_x', true)
  await channel.pinMessage?.('om_x', false)
  const path = await channel.downloadImage?.({ messageId: 'om_x', fileKey: 'img_1', outPath: 'data/images/x.png' })

  const kinds = logs.filter((l) => l.includes('[预演]')).map((l) => l.split('：')[0]!.replace(/.*\[预演\] /, ''))
  for (const k of ['发卡', '改卡', '置顶', '取消置顶', '下载图片']) {
    assert.ok(kinds.includes(k), `应当有「${k}」这一条预演，实际：${kinds.join('/')}`)
  }
  assert.equal(path, 'data/images/x.png', '预演时图片路径原样返回，不假装下载成功')
  // 取消置顶必须带 --yes（high-risk-write）
  const unpin = logs.find((l) => l.includes('[预演] 取消置顶'))!
  assert.ok(unpin.includes('--yes'), '取消置顶不带 --yes 会被 CLI 拒')
})
