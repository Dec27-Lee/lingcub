import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fingerprint, planSectionWrite, sectionBody } from '../src/domain/doc-write.ts'

const md = '# 计划\n\n## AI 进度\n- [ ] [t1] 写登录\n\n## 人工\n保留这行'

test('doc-write：取小节正文，不跨到下一个标题', () => {
  assert.equal(sectionBody(md, 'AI 进度'), '- [ ] [t1] 写登录')
  assert.equal(sectionBody(md, '人工'), '保留这行')
  assert.equal(sectionBody(md, '不存在'), null)
})

test('doc-write：版本与指纹一致时只替换自己小节', () => {
  const d = planSectionWrite(
    { revision: 'r1', markdown: md },
    'AI 进度',
    '- [x] [t1] 写登录',
    { revision: 'r1', fingerprint: fingerprint(md) },
  )
  assert.equal(d.ok, true)
  if (!d.ok) return
  assert.match(d.markdown, /## AI 进度\n- \[x\] \[t1\] 写登录\n\n## 人工/)
  assert.match(d.markdown, /## 人工\n保留这行$/)
})

test('doc-write：版本或指纹不一致即冲突，不写', () => {
  const rev = planSectionWrite({ revision: 'r2', markdown: md }, 'AI 进度', 'x', {
    revision: 'r1',
    fingerprint: fingerprint(md),
  })
  assert.deepEqual(rev, { ok: false, reason: 'revision', actualRevision: 'r2' })

  const fp = planSectionWrite({ revision: 'r1', markdown: md + '\n' }, 'AI 进度', 'x', {
    revision: 'r1',
    fingerprint: fingerprint(md),
  })
  assert.deepEqual(fp, { ok: false, reason: 'fingerprint', actualRevision: 'r1' })

  const miss = planSectionWrite({ revision: 'r1', markdown: md }, '新节', 'x', {
    revision: 'r1',
    fingerprint: fingerprint(md),
  })
  assert.deepEqual(miss, { ok: false, reason: 'missing-section', actualRevision: 'r1' })
})
