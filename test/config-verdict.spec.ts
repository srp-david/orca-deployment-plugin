// "설정 확인" 판정: 패널과 워커(상태 표시줄·알림)가 같이 쓴다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configVerdict } from '../src/config-verdict.ts'

const row = (kind: 'M' | 'A', remote: string) => ({ kind, local: 'x', remote, note: '' })

test('이미 반영됨만 있으면 맞음 — 뒤에 다시 바뀐 파일(main 에 이후 변경)은 빼고 본다', () => {
  const v = configVerdict({
    errors: [
      'main 에 이후 변경 있음(HEAD 파일 ≠ 반영 커밋): src/a.xml',
      '운영본이 이미 반영 커밋 내용과 같음(이미 반영됨?): /R/b.xml'
    ],
    rows: [row('M', '/R/b.xml')]
  })
  assert.equal(v.ok, true)
  assert.match(v.lines[0], /맞음: 1개/)
})

test('운영에만 있는 수정·운영에 없는 경로·이미 반영된 파일 없음은 다시 보라고 한다', () => {
  assert.equal(configVerdict({ errors: ['운영본이 직전 커밋과 다름(운영에만 있는 수정?): /R/a'], rows: [] }).ok, false)
  const fresh = configVerdict({ errors: ['운영본이 이미 반영 커밋 내용과 같음(이미 반영됨?): /R/b'], rows: [row('A', '/R/new.xml')] })
  assert.equal(fresh.ok, false)
  assert.ok(fresh.lines.some((l) => l.includes('/R/new.xml')))
  const none = configVerdict({ errors: [], rows: [] })
  assert.equal(none.ok, false)
  assert.ok(none.lines.some((l) => l.includes('하나도 찾지 못함')))
})
