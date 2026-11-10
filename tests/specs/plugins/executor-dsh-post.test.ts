import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { z } from 'zod'
import type { Executor, Handle, Work } from '../../../src/domain/ports.ts'
import * as dsh from '../../../src/plugins/executor-dsh/index.ts'

const silent = (): void => {}

interface Mountable {
  manifest: { config: z.ZodTypeAny }
  setup: (ctx: never) => void
}

/** 用插件自己的 manifest 校验配置并 setup，拿到它注册的端口实现。 */
function mount<T>(mod: Mountable, raw: unknown): T {
  const config = mod.manifest.config.parse(raw)
  let impl: unknown = null
  ;(mod.setup as unknown as (ctx: unknown) => void)({
    config,
    log: silent,
    register: (i: unknown) => {
      impl = i
    },
  })
  assert.ok(impl, '插件没有注册端口实现')
  return impl as T
}

function work(over: Partial<Work> = {}): Work {
  return {
    id: 'work-1',
    intentId: 'i1',
    kind: 'session',
    project: 'lingcub',
    executor: 'dsh',
    workspace: tmpdir(),
    prompt: '把导出按钮加上',
    status: 'queued',
    ...over,
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 假 dsh 打印一行 NDJSON：拼进 `process.execPath -e <code>` 里执行。 */
function emit(obj: unknown): string {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(obj))}+'\\n')`
}

/** 一轮跑完后按句柄等到 finished，才能接着追加（串行闸要求这一轮已经结束）。 */
async function untilFinished(ex: Executor, handle: Handle): Promise<void> {
  await waitFor(async () => ((await ex.read(handle)).some((p) => p.kind === 'finished') ? true : null))
}

test('start：句柄用首行 session 的真实 id，Work id 在 dsh 这边不存在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dsh-start-'))
  const ex = mount<Executor>(dsh, {
    binary: process.execPath,
    allowRoots: [dir],
    args: [
      '-e',
      [emit({ type: 'session', sessionId: 'session-abc123', cwd: dir }), emit({ type: 'final', text: 'done' })].join(
        '\n',
      ),
    ],
  })
  const handle = await ex.start(work({ workspace: dir }))
  assert.equal(handle.sessionId, 'session-abc123', '句柄必须是真的 session id，不是 Work id')

  // 进度也挂在真实 id 上：按句柄读得到，说明 running 的 key 也是它
  await untilFinished(ex, handle)
  const ps = await ex.read(handle)
  assert.ok(ps.some((p) => p.kind === 'output'), '首行照旧收集成进度')
})

test('start：没拿到首行就回退 Work id，进程已退出就不空等 5 秒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dsh-nosession-'))
  const ex = mount<Executor>(dsh, {
    binary: process.execPath,
    allowRoots: [dir],
    args: ['-e', emit({ type: 'text', text: '没有 session 行' })],
  })
  const started = Date.now()
  const handle = await ex.start(work({ workspace: dir }))
  assert.equal(handle.sessionId, 'work-1')
  assert.ok(Date.now() - started < 3000, `进程已经退了就不该等满 5 秒，实际 ${Date.now() - started}ms`)
})

test('post：待发文本逐字从 stdin 送进已有会话，且 --session-id 用真实 id 渲染', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dsh-post-'))
  const received = join(dir, 'stdin.txt')
  const argvFile = join(dir, 'argv.json')
  const postCode = [
    "let s=''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data',(d)=>{s+=d})",
    `process.stdin.on('end',()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(received)},s);fs.writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(1)));${emit({ type: 'final', text: 'ok' })}})`,
  ].join('\n')
  const ex = mount<Executor>(dsh, {
    binary: process.execPath,
    allowRoots: [dir],
    args: [
      '-e',
      [emit({ type: 'session', sessionId: 'session-post-1', cwd: dir }), emit({ type: 'final', text: 'done' })].join(
        '\n',
      ),
    ],
    postArgs: ['-e', postCode, '{{sessionId}}'],
  })
  const handle = await ex.start(work({ workspace: dir }))
  await untilFinished(ex, handle)

  const text = '［yy］用户说：“把导出按钮加上”\n第二行也要原样送到'
  await ex.post!(handle, text)
  assert.equal(readFileSync(received, 'utf8'), text, 'stdin 收到的必须逐字等于待发文本')
  assert.deepEqual(JSON.parse(readFileSync(argvFile, 'utf8')), ['session-post-1'], '模板里的 id 是真实 id')
})

test('post：退出码非 0 就抛错（附 error 行说明），不把失败当成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dsh-post-fail-'))
  const ex = mount<Executor>(dsh, {
    binary: process.execPath,
    allowRoots: [dir],
    args: [
      '-e',
      [emit({ type: 'session', sessionId: 'session-fail-1', cwd: dir }), emit({ type: 'final', text: 'done' })].join(
        '\n',
      ),
    ],
    postArgs: ['-e', `${emit({ type: 'error', message: '会话不存在' })};process.exitCode = 1`],
  })
  const handle = await ex.start(work({ workspace: dir }))
  await untilFinished(ex, handle)
  await assert.rejects(() => ex.post!(handle, '再来一句'), /exit=1.*会话不存在/)
})

test('post：退出 0 但没有 final 行也算失败（不认「写完就算成」）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dsh-post-nofinal-'))
  const ex = mount<Executor>(dsh, {
    binary: process.execPath,
    allowRoots: [dir],
    args: [
      '-e',
      [emit({ type: 'session', sessionId: 'session-nofinal-1', cwd: dir }), emit({ type: 'final', text: 'done' })].join(
        '\n',
      ),
    ],
    postArgs: ['-e', emit({ type: 'text', text: '只说了句话，没有 final' })],
  })
  const handle = await ex.start(work({ workspace: dir }))
  await untilFinished(ex, handle)
  await assert.rejects(() => ex.post!(handle, '再来一句'), /没有 final 行/)
})

test('post：这一轮还在跑时不许追加（同一会话不能并发两轮）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dsh-post-busy-'))
  const ex = mount<Executor>(dsh, {
    binary: process.execPath,
    allowRoots: [dir],
    // 首行给了 id 之后继续赖着不退：模拟「这一轮还没跑完」
    args: ['-e', [emit({ type: 'session', sessionId: 'session-busy-1', cwd: dir }), 'setInterval(()=>{},1000)'].join('\n')],
    postArgs: ['-e', emit({ type: 'final', text: 'ok' })],
  })
  const handle = await ex.start(work({ workspace: dir }))
  try {
    await assert.rejects(() => ex.post!(handle, '插一句'), /还在跑/)
  } finally {
    await ex.stop(handle)
  }
})

test('start：args 含 "-" 时把 prompt 写进 dsh stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingcub-dsh-stdin-'))
  const out = join(dir, 'stdin.txt')
  const code = [
    "let s=''",
    "process.stdin.on('data',d=>s+=d)",
    "process.stdin.on('end',()=>{require('fs').writeFileSync(" + JSON.stringify(out) + ",s)",
    "process.stdout.write(JSON.stringify({type:'session',sessionId:'session-stdin',cwd:" + JSON.stringify(dir) + "})+'\\n')",
    "process.stdout.write(JSON.stringify({type:'final',text:'done'})+'\\n')})",
  ].join('\n')
  const ex = mount<Executor>(dsh, {
    binary: process.execPath,
    allowRoots: [dir],
    args: ['-e', code, '-'],
  })
  const handle = await ex.start(work({ workspace: dir }))
  await untilFinished(ex, handle)
  assert.equal(handle.sessionId, 'session-stdin')
  assert.match(readFileSync(out, 'utf8'), /把导出按钮加上/)
})
