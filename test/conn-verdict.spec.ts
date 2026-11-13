// "접속 확인" 판정: 워커가 curl 결과를 사람이 읽을 말로 바꾼다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connVerdict } from '../src/conn-verdict.ts'
import { prepareSave, type Target } from '../src/engine/target.ts'

const t: Target = {
  id: 'app',
  label: 'App',
  repo: 'C:/work/repos/app',
  runs: 'C:/work/runs/app',
  connection: { protocol: 'ftp', host: 'ftp.example.com', port: 2121, root: '/webapps/ROOT' },
  mappings: [{ local: 'src/main/webapp', remote: '/' }],
  manual: []
}

test('성공은 로그인과 운영 루트 목록 조회까지만 말한다 — 경로 매핑이 맞다는 뜻이 아니다', () => {
  const v = connVerdict(t, { ok: true, count: 12 }, 20)
  assert.equal(v.result, 'ok')
  assert.match(v.message, /운영 루트\(\/webapps\/ROOT\) 목록 조회 성공 — 항목 12개/)
  assert.match(v.message, /경로 매핑이 맞는지는 설정 확인으로/)
})

test('운영 루트가 비어 있으면 성공으로 치지 않고 경로를 의심하게 한다', () => {
  const v = connVerdict(t, { ok: true, count: 0 }, 20)
  assert.equal(v.result, 'empty')
  assert.match(v.message, /비어 있음 — 운영 루트 경로가 맞는지/)
})

test('실패는 원인별로 무엇을 볼지 알려 준다', () => {
  const says = (code: number) => {
    const v = connVerdict(t, { ok: false, code, err: `curl: (${code}) something` }, 20)
    assert.equal(v.result, 'failed')
    assert.ok(v.message.endsWith(`[curl ${code}]`), v.message)
    return v.message
  }
  assert.match(says(6), /서버 이름을 찾지 못함: ftp\.example\.com/)
  assert.match(says(7), /서버에 연결하지 못함: ftp\.example\.com:2121/)
  assert.match(says(28), /20초 안에 응답이 없음/)
  assert.match(says(67), /로그인 실패 — 저장한 사용자 이름과 비밀번호/)
  assert.match(says(9), /로그인은 됐지만 운영 루트\(\/webapps\/ROOT\) 폴더에 들어가지 못함/)
  assert.match(says(19), /목록을 받지 못함/)
  assert.match(says(78), /목록을 받지 못함/)
  assert.match(says(13), /패시브 모드\(고급 설정\)를 바꿔 보세요/)
  assert.match(says(56), /접속 확인 실패: curl: \(56\) something/)
  assert.match(says(-1), /curl 을 실행하지 못했거나 응답 없이 끝남: curl: \(-1\) something/)
  assert.match(connVerdict(t, { ok: false, code: -1, err: '' }, 20).message, /응답 없이 끝남 \[curl -1\]/)
})

test('포트를 적지 않은 설정은 21 로 말한다', () => {
  const v = connVerdict({ ...t, connection: { ...t.connection, port: undefined } }, { ok: false, code: 7, err: '' }, 20)
  assert.match(v.message, /ftp\.example\.com:21 /)
})

// ── 저장할 때 채우는 기본값 ──

test('저장 준비: 비워 둔 표시 이름은 대상 이름으로, 새 대상의 비워 둔 run 기록 폴더는 기본 위치로', () => {
  const fresh = prepareSave({ ...t, label: '', runs: '' }, true)
  assert.deepEqual(fresh.errors, [])
  assert.equal(fresh.target.label, 'app')
  assert.match(fresh.target.runs, /\/runs\/app$/)
  // 적어 둔 값은 그대로
  const kept = prepareSave(t, true)
  assert.equal(kept.target.label, 'App')
  assert.equal(kept.target.runs, 'C:/work/runs/app')
})

test('저장 준비: 이미 있는 대상의 run 기록 폴더는 채우지 않고 잘못으로 알린다', () => {
  const r = prepareSave({ ...t, runs: '' }, false)
  assert.equal(r.target.runs, '')
  assert.deepEqual(r.errors, ['run 기록 폴더가 필요함'])
})

test('저장 준비: 대상 이름이 틀리면 채우지 못한 칸은 탓하지 않고, 다른 잘못은 그대로 알린다', () => {
  const r = prepareSave({ ...t, id: 'Bad-Name', label: '', runs: '', repo: '' }, true)
  assert.equal(r.errors.length, 2, JSON.stringify(r.errors))
  assert.ok(r.errors[0].includes('대상 이름은'))
  assert.ok(r.errors[1].includes('메인 체크아웃'))
  // 이미 있는 대상이면 run 기록 폴더는 원래 채우지 않는 칸이라 그대로 알린다
  const old = prepareSave({ ...t, id: 'Bad-Name', label: '', runs: '' }, false)
  assert.ok(old.errors.some((x) => x.includes('run 기록 폴더')))
  assert.ok(!old.errors.some((x) => x.includes('표시 이름')))
})
