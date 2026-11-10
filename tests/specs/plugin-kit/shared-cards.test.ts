import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderResumeCard } from '../../../src/plugin-kit/feishu-cards.ts'

const items = [{ label: '旧会话 · claude', sessionId: 'old-1', cwd: 'E:\\ws', executor: 'claude' }]

function buttons(card: unknown): { value: Record<string, string> }[] {
  const c = card as { elements: { tag: string; actions?: { value: Record<string, string> }[] }[] }
  return c.elements.find((e) => e.tag === 'action')?.actions ?? []
}

test('renderResumeCard：恢复与接入用不同的回调 k', () => {
  const resume = buttons(renderResumeCard({ chatId: 'c1', items, rebindSessionId: 's1' }))
  assert.equal(resume[0]?.value['k'], 'resume')
  assert.equal(resume[0]?.value['rebind'], 's1')
  const attach = buttons(renderResumeCard({ chatId: 'c1', items, attach: true }))
  assert.equal(attach[0]?.value['k'], 'attach')
  assert.equal(attach[0]?.value['exec'], 'claude')
})
