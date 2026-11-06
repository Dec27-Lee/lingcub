import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PluginContextV2 } from '../src/domain/plugin-v2.ts'
import type { DocPort } from '../src/domain/ports.ts'
import * as docFeishu from '../src/plugins/capability-doc-feishu/index.ts'

/**
 * 假命令：`process.execPath -e <script> <payload>`，payload 文件就是它要打印的 stdout。
 * 脚本同时把收到的 argv 与 stdin 落到同目录文件，测试从文件断言（不联网，不碰真实飞书）。
 */
const FAKE_SCRIPT =
  "const fs=require('node:fs');const p=process.argv[1];" +
  "const s=fs.readFileSync(0,'utf8');" +
  "fs.writeFileSync(p+'.stdin',s);" +
  "fs.writeFileSync(p+'.argv',JSON.stringify(process.argv.slice(2)));" +
  "process.stdout.write(fs.readFileSync(p,'utf8'))"

const FAIL_SCRIPT = "process.stderr.write('boom: fake lark-cli failed');process.exit(3)"

const SAMPLE_XML =
  '<h3 id="h1" align="center">✅ 我的待办</h3><hr id="r1"/><checkbox id="c1" done="true">Item 1</checkbox><p id="p1"></p><h3 id="h2">📝 记录</h3><p id="p2">正文</p>'

interface Fake {
  /** stdout 内容（JSON 字符串或裸文本） */
  payload: string
  argvFile: string
  stdinFile: string
}

function fake(stdout: unknown): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-doc-feishu-'))
  const file = join(dir, 'stdout.txt')
  writeFileSync(file, typeof stdout === 'string' ? stdout : JSON.stringify(stdout), 'utf8')
  return { payload: file, argvFile: `${file}.argv`, stdinFile: `${file}.stdin` }
}

/** 默认参数形状 + 假命令前缀；只替换模板里真正用到的片段。 */
function argsWith(f: Fake, tail: readonly string[]): string[] {
  return ['-e', FAKE_SCRIPT, f.payload, ...tail]
}

function failedArgs(): string[] {
  return ['-e', FAIL_SCRIPT]
}

function makePort(args: {
  readArgs: string[]
  fetchXmlArgs: string[]
  writeArgs: string[]
}): DocPort {
  let registered: DocPort | undefined
  const config = docFeishu.manifest.config.parse({ binary: process.execPath, ...args })
  docFeishu.setup({
    config,
    registerPort: (port: DocPort) => {
      registered = port
    },
  } as unknown as PluginContextV2)
  assert.ok(registered, 'setup 必须注册 doc 端口')
  return registered
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}

test('doc-feishu：清单 id/role 与默认参数模板（strict 拒未知键）', () => {
  assert.equal(docFeishu.manifest.id, 'capability-doc-feishu')
  assert.deepEqual(docFeishu.manifest.roles, ['doc'])
  const cfg = docFeishu.manifest.config.parse({}) as {
    binary: string
    readArgs: string[]
    fetchXmlArgs: string[]
    writeArgs: string[]
    timeoutMs: number
  }
  assert.equal(cfg.binary, 'lark-cli')
  assert.deepEqual(cfg.readArgs, [
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
  ])
  assert.deepEqual(cfg.fetchXmlArgs, [
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
  ])
  assert.deepEqual(cfg.writeArgs, [
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
  ])
  assert.equal(cfg.timeoutMs, 120_000)
  assert.throws(() => docFeishu.manifest.config.parse({ bogus: true }), /Unrecognized|unrecognized/)
})

test('doc-feishu：read 取 revision 与 markdown，doc 占位符渲染进 argv', async () => {
  const f = fake({ ok: true, data: { document: { revision_id: 1234, content: '# 我的文档\n正文' } } })
  const port = makePort({
    readArgs: argsWith(f, ['--doc', '{{doc}}', '--doc-format', 'markdown']),
    fetchXmlArgs: [],
    writeArgs: [],
  })
  const got = await port.read('doccnABC')
  assert.deepEqual(got, { revision: '1234', markdown: '# 我的文档\n正文' })
  assert.deepEqual(readJson(f.argvFile), ['--doc', 'doccnABC', '--doc-format', 'markdown'])
})

test('doc-feishu：read 缺 revision_id 时回退正文指纹', async () => {
  const body = '# 只有正文'
  const f = fake({ ok: true, data: { document: { markdown: body } } })
  const port = makePort({
    readArgs: argsWith(f, ['--doc', '{{doc}}']),
    fetchXmlArgs: [],
    writeArgs: [],
  })
  const got = await port.read('doccnABC')
  assert.equal(got.markdown, body)
  assert.equal(got.revision, createHash('sha256').update(body, 'utf8').digest('hex'))
})

test('doc-feishu：命令退出非 0 即失败，不把 stdout 当结果', async () => {
  const port = makePort({ readArgs: failedArgs(), fetchXmlArgs: [], writeArgs: [] })
  await assert.rejects(port.read('doccnABC'), /飞书文档读取失败（code=3）：boom/)
})

test('doc-feishu：writeSection 按小节 block_replace，stdin 收到 XML', async () => {
  const fetchFake = fake({
    ok: true,
    data: { document: { revision_id: 7, content: SAMPLE_XML } },
  })
  const writeFake = fake({ ok: true, data: { document: { revision_id: 9 } } })
  const port = makePort({
    readArgs: [],
    fetchXmlArgs: argsWith(fetchFake, [
      '--doc',
      '{{doc}}',
      '--doc-format',
      'xml',
      '--detail',
      'with-ids',
      '--revision-id',
      '-1',
    ]),
    writeArgs: argsWith(writeFake, [
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
  })

  const got = await port.writeSection!('doccnABC', '✅ 我的待办', '- [x] 写回\n- [ ] 复核', {
    revision: '7',
  })
  assert.deepEqual(got, { revision: '9' })
  assert.deepEqual(readJson(fetchFake.argvFile), [
    '--doc',
    'doccnABC',
    '--doc-format',
    'xml',
    '--detail',
    'with-ids',
    '--revision-id',
    '-1',
  ])
  assert.deepEqual(readJson(writeFake.argvFile), [
    '--doc',
    'doccnABC',
    '--command',
    'block_replace',
    '--start-block-id',
    'h1',
    '--end-block-id',
    'p1',
    '--doc-format',
    'xml',
    '--revision-id',
    '7',
    '--content',
    '-',
  ])
  const stdin = readFileSync(writeFake.stdinFile, 'utf8')
  assert.equal(
    stdin,
    '<h3>✅ 我的待办</h3><checkbox done="true">写回</checkbox><checkbox done="false">复核</checkbox>',
  )
})

test('doc-feishu：fetch 的 revision 与调用方期望不一致时冲突，不写', async () => {
  const fetchFake = fake({ ok: true, data: { document: { revision_id: 8, content: SAMPLE_XML } } })
  const writeFake = fake({ ok: true, data: { document: { revision_id: 9 } } })
  const port = makePort({
    readArgs: [],
    fetchXmlArgs: argsWith(fetchFake, ['--doc', '{{doc}}']),
    writeArgs: argsWith(writeFake, ['--doc', '{{doc}}']),
  })
  await assert.rejects(
    port.writeSection!('doccnABC', '✅ 我的待办', 'x', { revision: '7' }),
    /文档版本冲突：期望 7，实际 8/,
  )
  assert.equal(existsSync(writeFake.argvFile), false, '冲突时不能发起写命令')
})

test('doc-feishu：找不到小节就报错，不猜位置', async () => {
  const fetchFake = fake({
    ok: true,
    data: { document: { revision_id: 7, content: '<h3 id="h2">📝 记录</h3><p id="p2">正文</p>' } },
  })
  const port = makePort({
    readArgs: [],
    fetchXmlArgs: argsWith(fetchFake, ['--doc', '{{doc}}']),
    writeArgs: argsWith(fetchFake, ['--doc', '{{doc}}']),
  })
  await assert.rejects(
    port.writeSection!('doccnABC', '✅ 我的待办', 'x', { revision: '7' }),
    /文档里找不到小节：✅ 我的待办/,
  )
})

test('doc-feishu：写命令退出非 0 即失败', async () => {
  const fetchFake = fake({ ok: true, data: { document: { revision_id: 7, content: SAMPLE_XML } } })
  const port = makePort({
    readArgs: [],
    fetchXmlArgs: argsWith(fetchFake, ['--doc', '{{doc}}']),
    writeArgs: failedArgs(),
  })
  await assert.rejects(
    port.writeSection!('doccnABC', '✅ 我的待办', 'x', { revision: '7' }),
    /飞书文档写回失败（code=3）：boom/,
  )
})

test('doc-feishu：信封 ok=false 按失败处理（exit 0 也不算成功）', async () => {
  const fetchFake = fake({ ok: false, error: { message: 'missing_scope' } })
  const port = makePort({
    readArgs: [],
    fetchXmlArgs: argsWith(fetchFake, ['--doc', '{{doc}}']),
    writeArgs: [],
  })
  await assert.rejects(
    port.writeSection!('doccnABC', '✅ 我的待办', 'x', { revision: '7' }),
    /飞书文档读取 XML 失败：missing_scope/,
  )
})

test('doc-feishu：write 拒绝整篇覆盖（docx 会丢评论/资源）', async () => {
  const port = makePort({ readArgs: [], fetchXmlArgs: [], writeArgs: [] })
  await assert.rejects(port.write('doccnABC', '# 整篇', { revision: '1' }), /不支持整篇覆盖/)
})
