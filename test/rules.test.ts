import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { Event } from '../src/domain/types.ts'
import { eventId } from '../src/kernel/ids.ts'
import { evaluate, loadRules, type Ruleset } from '../src/routing/rules.ts'

function rulesFrom(yaml: string): Ruleset {
  const file = join(mkdtempSync(join(tmpdir(), 'lingcub-rules-')), 'rules.yaml')
  writeFileSync(file, yaml)
  return loadRules(file)
}

function ev(over: Partial<Event> = {}): Event {
  const externalId = over.externalId ?? 'm1'
  return {
    id: eventId('feishu-im', externalId),
    source: 'feishu-im',
    externalId,
    receivedAt: '2026-11-03T09:00:00.000Z',
    occurredAt: '2026-11-03T09:00:00.000Z',
    actor: { id: 'u1', name: 'Yue' },
    channel: { kind: 'group', id: 'g1', name: '研发群' },
    text: '登录页报错了',
    raw: {},
    ...over,
  }
}

test('首个命中即停：两条规则都能匹配，只认第一条', () => {
  const rs = rulesFrom(`
rules:
  - id: first
    when: { channel: group }
    then: { kind: dev-request, confidence: 1 }
  - id: second
    when: { textMatches: '(bug|报错)' }
    then: { kind: bug, confidence: 1 }
`)
  const intent = evaluate(rs, ev())
  assert.equal(intent?.byRule, 'first')
  assert.equal(intent?.kind, 'dev-request')
})

test('谓词之间是 AND：atMe 不满足就往下走', () => {
  const rs = rulesFrom(`
rules:
  - id: at-me
    when: { channel: group, atMe: true }
    then: { kind: dev-request, confidence: 0.9 }
  - id: fallback
    when: { always: true }
    then: { kind: chatter, confidence: 0.5 }
`)
  assert.equal(evaluate(rs, ev({ atMe: false }))?.byRule, 'fallback')
  assert.equal(evaluate(rs, ev({ atMe: true }))?.byRule, 'at-me')
})

test('groupIn: allowlist 只认 allowlist 里的群', () => {
  const rs = rulesFrom(`
rules:
  - id: allowlisted-group
    when: { channel: group, groupIn: allowlist }
    then: { kind: dev-request, confidence: 0.8 }
allowlist:
  groups: [g-ok]
`)
  assert.equal(evaluate(rs, ev({ channel: { kind: 'group', id: 'g-no' } })), null)
  assert.equal(evaluate(rs, ev({ channel: { kind: 'group', id: 'g-ok' } }))?.byRule, 'allowlisted-group')
})

test('生产规则：钉钉单聊只有真问句才落只读，陈述继续往下走', () => {
  const rs = loadRules(resolve('config/rules.yaml'))
  const dm = { channel: { kind: 'dm' as const, id: 'd1' } }
  assert.equal(evaluate(rs, ev({ ...dm, text: '这个怎么处理？' }))?.byRule, 'dm-is-question')
  assert.equal(evaluate(rs, ev({ ...dm, text: '账号本身不太稳定，先别建' })), null)
})

test('规则不写 suggestedAction 时按 kind 查表补默认动作', () => {
  const rs = rulesFrom(`
rules:
  - id: r
    when: { always: true }
    then: { kind: bug, confidence: 0.8 }
`)
  assert.equal(evaluate(rs, ev())?.suggestedAction, 'dispatch_session')
})

test('规则可覆盖默认动作与 project', () => {
  const rs = rulesFrom(`
rules:
  - id: r
    when: { always: true }
    then: { kind: bug, suggestedAction: reply_only, project: lingcub, confidence: 0.8 }
`)
  const intent = evaluate(rs, ev())
  assert.equal(intent?.suggestedAction, 'reply_only')
  assert.equal(intent?.project, 'lingcub')
})

test('未命中任何规则返回 null（交给分类器）', () => {
  const rs = rulesFrom(`
rules:
  - id: dm-only
    when: { channel: dm }
    then: { kind: question, confidence: 1 }
`)
  assert.equal(evaluate(rs, ev()), null)
})

test('未知谓词键直接报错，不静默失效', () => {
  assert.throws(
    () =>
      rulesFrom(`
rules:
  - id: r
    when: { chanel: group }
    then: { kind: bug, confidence: 1 }
`),
    /校验失败/,
  )
})

test('空谓词直接报错，避免写成匹配一切', () => {
  assert.throws(
    () =>
      rulesFrom(`
rules:
  - id: r
    when: {}
    then: { kind: bug, confidence: 1 }
`),
    /至少要有一个谓词/,
  )
})

test('textMatches 非法正则在加载期就报错', () => {
  assert.throws(
    () =>
      rulesFrom(`
rules:
  - id: r
    when: { textMatches: '([a-' }
    then: { kind: bug, confidence: 1 }
`),
    /不是合法正则/,
  )
})

test('规则 id 重复报错', () => {
  assert.throws(
    () =>
      rulesFrom(`
rules:
  - id: r
    when: { always: true }
    then: { kind: bug, confidence: 1 }
  - id: r
    when: { channel: dm }
    then: { kind: question, confidence: 1 }
`),
    /规则 id 重复/,
  )
})

test('仓库自带的 config/rules.yaml 能加载', () => {
  const rs = loadRules(resolve(import.meta.dirname, '../config/rules.yaml'))
  assert.ok(rs.rules.length >= 5)
  assert.equal(rs.rules[0]?.id, 'dm-is-question')
})
