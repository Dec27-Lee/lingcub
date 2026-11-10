import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startUi } from '../../../src/desktop/server.ts'
import { openStore } from '../../../src/kernel/store.ts'
import { Outbox } from '../../../src/kernel/outbox.ts'

test('面板：工作站区块与 /api/workstation 可用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lingcub-ui-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'config/lingcub.yaml'), 'mode: auto\nstore:\n  path: data/test.db\n', 'utf8')
  writeFileSync(join(root, 'config/projects.yaml'), 'workspaces: []\n', 'utf8')
  writeFileSync(join(root, 'config/rules.yaml'), 'rules: []\n', 'utf8')
  const db = openStore(join(root, 'data/test.db'))
  const t = '2026-11-04T00:00:00Z'
  db.insertSession({
    id: 'sess-ui',
    chatId: 'oc_1',
    threadId: 'th_1',
    title: '面板里的窗口',
    executor: 'dsh',
    workspace: 'proj',
    status: 'active',
    createdAt: t,
    lastActiveAt: t,
  })
  const outbox = new Outbox(db, async () => ({}), { log: () => {} })
  outbox.enqueue({ kind: 'reply_only', text: '面板排障' }, 'op:ui')
  db.close()

  const ui = await startUi({ root, port: 0, idleExitMs: 0, open: false })
  try {
    const page = await (await fetch(ui.url)).text()
    assert.match(page, /id="view"/)
    const token = new URL(ui.url).searchParams.get('t')
    const r = await fetch(`http://127.0.0.1:${ui.port}/api/workstation?t=${token}`)
    assert.equal(r.status, 200)
    const data = (await r.json()) as { sessions: Record<string, number>; outbox: Record<string, number> }
    assert.deepEqual(data.sessions, { active: 1 })
    assert.equal(data.outbox.pending, 1)

    const sr = await fetch(`http://127.0.0.1:${ui.port}/api/workstation/sessions?t=${token}`)
    const sd = (await sr.json()) as { ok: boolean; sessions: { id: string; title?: string }[] }
    assert.equal(sd.ok, true)
    assert.equal(sd.sessions[0]?.id, 'sess-ui')
    assert.equal(sd.sessions[0]?.title, '面板里的窗口')

    const dr = await fetch(`http://127.0.0.1:${ui.port}/api/workstation/sessions/sess-ui?t=${token}`)
    const dd = (await dr.json()) as { ok: boolean; session: { id: string; executor: string } }
    assert.equal(dd.ok, true)
    assert.equal(dd.session.executor, 'dsh')
    const miss = await fetch(`http://127.0.0.1:${ui.port}/api/workstation/sessions/nope?t=${token}`)
    assert.equal(miss.status, 404)

    const ob = await fetch(`http://127.0.0.1:${ui.port}/api/workstation/outbox?status=pending&t=${token}`)
    const od = (await ob.json()) as { ok: boolean; rows: { kind: string; dedupeKey: string }[] }
    assert.equal(od.ok, true)
    assert.equal(od.rows[0]?.kind, 'reply_only')
    assert.equal(od.rows[0]?.dedupeKey, 'op:ui')
  } finally {
    await ui.close()
    rmSync(root, { recursive: true, force: true })
  }
})
