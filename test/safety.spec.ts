// 리뷰(2026-11-06 Codex 1·2차)에서 나온 안전 문제의 회귀 시험. FTP 없이 run 기록·잠금·설정만으로 본다.
// 사용법: node --test test/safety.spec.ts
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'pd-safety-')).replace(/\\/g, '/')
process.env.PRODDEPLOY_HOME = `${tmp}/home`

const { acquireLock, clearStaleLock, listRuns, newRun, openRun, readLock } = await import('../src/engine/runs.ts')
const { configChanged, laterOverlaps, rollback } = await import('../src/engine/steps.ts')
const { deleteTarget, saveTarget } = await import('../src/engine/target.ts')
const { sha256, toMsys } = await import('../src/engine/util.ts')

const target = {
  id: 'fx',
  label: 'FX',
  repo: `${tmp}/repo`,
  runs: `${tmp}/runs`,
  connection: { protocol: 'ftp' as const, host: '127.0.0.1', port: 2121, root: '/app' },
  mappings: [{ local: 'src/main/webapp', remote: '/' }],
  manual: []
}
saveTarget(target)
const lockPath = `${tmp}/home/locks/fx.lock`
const repoMsys = toMsys(`${tmp}/repo`)

type Fake = {
  upload?: number
  done?: string | boolean
  planDone?: boolean
  log?: string
  snapshot?: boolean
  dir?: string
  logOnly?: boolean
  /** 업로드한 계정의 지문(upload.account). 없으면 지문을 남기기 전의 기록. */
  account?: string
}

/** run 폴더를 손으로 만든다. upload: 새 형식 업로드 시작 ms, done: upload.done 내용(bash 형식 날짜) 또는 true. */
function fakeRun(id: string, files: string[], o: Fake = {}) {
  const dir = `${o.dir ?? `${tmp}/runs`}/${id}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/meta.env`, `RUN_TARGET=fx\nBASE=b\nTIP=t\nHEADC=h\n`)
  if (o.snapshot !== false) writeFileSync(`${dir}/target.json`, JSON.stringify(target))
  writeFileSync(`${dir}/errors.txt`, '')
  writeFileSync(`${dir}/plan.tsv`, files.map((f) => `M\t${repoMsys}/src/main/webapp/${f}\t/app/${f}\taaa\tbbb\t\n`).join(''))
  if (o.planDone !== false) writeFileSync(`${dir}/plan.done`, 'x\n')
  if (o.log) writeFileSync(`${dir}/deploy.log`, o.log)
  writeFileSync(`${dir}/backup.done`, 'x\n')
  if (o.upload) writeFileSync(`${dir}/upload.started`, `x\n${o.upload}\n`)
  if (o.account) writeFileSync(`${dir}/upload.account`, `${o.account}\n`)
  if (o.done) writeFileSync(`${dir}/upload.done`, o.done === true ? '2026-11-06 12:00:00\n' : `${o.done}\n`)
  return openRun(id)
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  return new Promise<number>((r) => child.on('exit', () => r(child.pid!)))
}

test('잠금: 살아 있는 잠금이 있으면 멈추고, 해제는 자기 것만 (리뷰 #1)', () => {
  const release = acquireLock({ target: 'fx', run: 'a', step: 'upload', by: 't' })
  assert.throws(() => acquireLock({ target: 'fx', run: 'b', step: 'upload', by: 't' }), /다른 작업 중/)
  assert.throws(() => clearStaleLock('fx'), /살아 있는 작업/)
  assert.equal(readLock('fx')?.run, 'a')
  release()
  assert.equal(readLock('fx'), null)
})

test('잠금: 죽은 작업의 잠금은 자동으로 치우지 않고, 사람이 풀어야 잡힌다 (리뷰 R1)', async () => {
  const pid = await deadPid()
  writeFileSync(lockPath, JSON.stringify({ target: 'fx', run: 'old', step: 'upload', pid, startedAt: 'x', by: 't', token: 'dead' }))
  assert.throws(() => acquireLock({ target: 'fx', run: 'c', step: 'upload', by: 't' }), /끝난 작업의 잠금이 남아 있음/)
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).run, 'old', '자동으로 치우지 않음')
  assert.match(clearStaleLock('fx'), /풀었음/)
  const release = acquireLock({ target: 'fx', run: 'c', step: 'upload', by: 't' })
  // 남의 잠금은 풀지 않는다: 토큰이 다르면 그대로 둔다.
  writeFileSync(lockPath, JSON.stringify({ target: 'fx', run: 'other', step: 'upload', pid: process.pid, startedAt: 'x', by: 't', token: 'other' }))
  release()
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).run, 'other')
  rmSync(lockPath)
})

test('잠금: 내용이 빈 잠금은 막 만든 것이면 기다리라 하고, 오래됐으면 사람이 푼다 (리뷰 R1)', () => {
  writeFileSync(lockPath, '')
  assert.throws(() => acquireLock({ target: 'fx', run: 'b', step: 'upload', by: 't' }), /확인하는 중/)
  const old = Date.now() / 1000 - 60
  utimesSync(lockPath, old, old)
  assert.throws(() => acquireLock({ target: 'fx', run: 'b', step: 'upload', by: 't' }), /끝난 작업의 잠금/)
  assert.match(clearStaleLock('fx'), /내용 없는 잠금/)
  acquireLock({ target: 'fx', run: 'b', step: 'upload', by: 't' })()
})

test('plan.done 이 없으면 막힌 run (리뷰 #5)', () => {
  const r = fakeRun('fx-20261106-100000-aaaaaaa1', ['a.xml'], { planDone: false })
  assert.equal(r.status(), 'blocked')
  assert.match(r.errors().join('\n'), /plan 이 끝나지 않음/)
  // bash 시절 run 은 로그의 "plan 완료" 로 인정
  const legacy = fakeRun('fx-20261106-100001-aaaaaaa2', ['a.xml'], { planDone: false, log: '10:00:01 plan 완료: 1개, 코드 x\n' })
  assert.equal(legacy.status(), 'backedUp')
})

test('나중 run 판정은 이름순이 아니라 실제 업로드 시각 (리뷰 #8)', () => {
  // 이름(plan 시각)은 B 가 늦지만, 실제 업로드는 B 가 먼저, A 가 나중
  const a = fakeRun('fx-20261106-110000-aaaaaaa3', ['x.xml'], { upload: Date.UTC(2026, 10, 6, 5), done: true })
  const b = fakeRun('fx-20261106-120000-aaaaaaa4', ['x.xml'], { upload: Date.UTC(2026, 10, 6, 4), done: true })
  assert.deepEqual(laterOverlaps(b).map((x) => x.run), [a.id])
  assert.deepEqual(laterOverlaps(a).map((x) => x.run), [])
})

test('bash run 업로드 순서는 upload.done 의 날짜로, 모르면 막는 쪽 (리뷰 R4)', () => {
  // A: 11/1 plan, 11/3 업로드 / B: 11/2 plan, 11/2 업로드 → 실제로는 A 가 나중
  const a = fakeRun('fx-20261101-100000-bbbbbbb1', ['y.xml'], { done: '2026-11-03 11:00:00', snapshot: false })
  const b = fakeRun('fx-20261102-100000-bbbbbbb2', ['y.xml'], { done: '2026-11-02 11:00:00', snapshot: false })
  assert.deepEqual(laterOverlaps(b).map((x) => x.run), [a.id])
  assert.deepEqual(laterOverlaps(a).map((x) => x.run), [])
  // 날짜 없는 bash 부분 업로드: 순서를 모름
  const c = fakeRun('fx-20261104-100000-bbbbbbb3', ['y.xml'], { log: '10:00:00 plan 완료: 1개\n10:01:00 업로드 시작: x\n', snapshot: false })
  assert.equal(c.uploadAt(), 'unknown')
  assert.ok(laterOverlaps(a).some((x) => x.run === c.id && x.unknown))
})

test('백업 배치: 표시는 run 폴더의 backup.layout, 백업 안의 layout-v2 파일은 운영 파일일 뿐 (리뷰 #7, R5)', () => {
  const r = fakeRun('fx-20261106-130000-aaaaaaa5', ['layout-v2'])
  mkdirSync(r.path('backup'), { recursive: true })
  writeFileSync(r.path('backup/layout-v2'), 'bash 시절 운영 파일')
  assert.match(r.backupPath('/app/layout-v2').replace(/\\/g, '/'), /backup\/layout-v2$/)
  writeFileSync(r.path('backup.layout'), 'v2\n')
  assert.match(r.backupPath('/app/layout-v2').replace(/\\/g, '/'), /backup\/files\/layout-v2$/)
  assert.match(r.backupPath('/app/a.xml', 'backup.tmp').replace(/\\/g, '/'), /backup\.tmp\/files\/a\.xml$/)
})

test('대상 설정이 바뀌면 configChanged, 표시 이름만 바뀌면 아님 (리뷰 #6)', () => {
  const r = fakeRun('fx-20261106-140000-aaaaaaa6', ['a.xml'])
  assert.equal(configChanged(r), false)
  saveTarget({ ...target, label: '다른 이름' })
  assert.equal(configChanged(openRun(r.id)), false)
  saveTarget({ ...target, connection: { ...target.connection, root: '/OTHER' } })
  assert.equal(configChanged(openRun(r.id)), true)
  saveTarget(target)
})

test('bash run 은 기록된 대상 주소가 지금 설정과 다르면 쓰지 않고, 같으면 설정 사본을 만든다 (리뷰 R2)', async () => {
  const log = '10:00:00 대상: FX → ftp://127.0.0.1:2121/app\n10:00:01 plan 완료: 1개\n'
  const r = fakeRun('fx-20261106-160000-ccccccc1', ['a.xml'], { log, snapshot: false, upload: Date.now(), done: true })
  saveTarget({ ...target, connection: { ...target.connection, host: '10.0.0.9' } })
  await assert.rejects(rollback(r.id, r.code(), true), /대상 주소\(ftp:\/\/127\.0\.0\.1:2121\/app\)가 지금 설정/)
  assert.equal(existsSync(r.path('target.json')), false)
  saveTarget(target)
  // 같으면 사본을 만들고 다음 검사로 넘어간다(여기서는 틀린 확인 코드에서 멈춤 — FTP 까지 가지 않음)
  await assert.rejects(rollback(r.id, '00000000', true), /확인 코드가 다름/)
  assert.equal(JSON.parse(readFileSync(r.path('target.json'), 'utf8')).connection.host, '127.0.0.1')
  const noLog = fakeRun('fx-20261106-160001-ccccccc2', ['a.xml'], { snapshot: false, upload: Date.now(), done: true })
  await assert.rejects(rollback(noLog.id, noLog.code(), true), /대상 주소 기록이 없음/)
})

test('run 기록 폴더를 바꾸거나 지운 이름으로 다시 만들어도 예전 run 을 찾는다 (리뷰 #9, R3)', () => {
  const old = newRun(target as never, 'fx-20261106-170000-ddddddd1')
  writeFileSync(old.path('meta.env'), 'RUN_TARGET=fx\nBASE=b\nTIP=t\nHEADC=h\n')
  writeFileSync(old.path('plan.tsv'), `M\t${repoMsys}/src/main/webapp/z.xml\t/app/z.xml\taaa\tbbb\t\n`)
  writeFileSync(old.path('upload.done'), '2026-11-06 17:00:00\n')
  deleteTarget('fx')
  assert.equal(openRun(old.id).status(), 'blocked', '설정이 지워져도 열림(plan.done 없어 막힘 표시)')
  saveTarget({ ...target, runs: `${tmp}/new-runs` })
  assert.equal(openRun(old.id).id, old.id, '같은 이름으로 다시 만들고 run 폴더를 바꿔도 열림')
  assert.ok(listRuns({ ...target, runs: `${tmp}/new-runs` }).some((r) => r.id === old.id), '나중 run 판정에도 들어감')
  saveTarget(target)
})

// ── 3차 리뷰 ──────────────────────────────────────────────────

test('잠금 풀기는 한 번에 하나만: 다른 잠금 풀기가 도는 중이면 멈춘다 (리뷰 F1)', async () => {
  const pid = await deadPid()
  writeFileSync(lockPath, JSON.stringify({ target: 'fx', run: 'old', step: 'upload', pid, startedAt: 'x', by: 't', token: 'dead' }))
  writeFileSync(`${lockPath}.unlock`, '1')
  assert.throws(() => clearStaleLock('fx'), /잠금 풀기가 이미 도는 중/)
  assert.ok(existsSync(lockPath), '다른 잠금 풀기가 도는 동안은 지우지 않음')
  rmSync(`${lockPath}.unlock`)
  assert.match(clearStaleLock('fx'), /풀었음/)
  assert.equal(existsSync(`${lockPath}.unlock`), false, '끝나면 풀기 표시도 지움')
})

test('ftp 주소는 호스트·포트(없으면 21)·루트로 나눠 비교 (리뷰 F2)', async () => {
  const { parseFtpUrl } = await import('../src/engine/steps.ts')
  assert.deepEqual(parseFtpUrl('ftp://Host.Example/app/'), { host: 'host.example', port: 21, root: '/app' })
  assert.deepEqual(parseFtpUrl('ftp://1.2.3.4:2122/srv/ROOT'), { host: '1.2.3.4', port: 2122, root: '/srv/ROOT' })
  assert.equal(parseFtpUrl('http://x/y'), null)
  // 로그는 포트 생략(=21), 지금 설정은 2121 → 다른 서버로 보고 막는다
  const r = fakeRun('fx-20261106-180000-eeeeeee1', ['a.xml'], {
    log: '10:00:00 대상: FX → ftp://127.0.0.1/app\n10:00:01 plan 완료: 1개\n',
    snapshot: false,
    upload: Date.now(),
    done: true
  })
  await assert.rejects(rollback(r.id, r.code(), true), /대상 주소\(ftp:\/\/127\.0\.0\.1\/app\)가 지금 설정/)
  // 로그가 :2121 을 밝혀 적었으면 같은 서버 — 루트 대소문자는 구분
  const ok = fakeRun('fx-20261106-180001-eeeeeee2', ['a.xml'], {
    log: '10:00:00 대상: FX → ftp://127.0.0.1:2121/app/\n10:00:01 plan 완료: 1개\n',
    snapshot: false,
    upload: Date.now(),
    done: true
  })
  await assert.rejects(rollback(ok.id, '00000000', true), /확인 코드가 다름/)
  assert.ok(existsSync(ok.path('target.json')))
  const caseDiff = fakeRun('fx-20261106-180002-eeeeeee3', ['a.xml'], {
    log: '10:00:00 대상: FX → ftp://127.0.0.1:2121/APP\n10:00:01 plan 완료: 1개\n',
    snapshot: false,
    upload: Date.now(),
    done: true
  })
  await assert.rejects(rollback(caseDiff.id, caseDiff.code(), true), /대상 주소/)
})

test('색인이 없는 예전 run 만 있어도 run 기록 폴더를 바꾸면 이전 설정 이력으로 찾는다 (리뷰 F3)', () => {
  const fy = { ...target, id: 'fy', runs: `${tmp}/fy-old` }
  saveTarget(fy)
  const dir = `${tmp}/fy-old/fy-20261106-190000-fffffff1`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/meta.env`, 'RUN_TARGET=fy\nBASE=b\nTIP=t\nHEADC=h\n')
  writeFileSync(`${dir}/plan.tsv`, '')
  saveTarget({ ...fy, runs: `${tmp}/fy-new` })
  assert.equal(openRun('fy-20261106-190000-fffffff1').id, 'fy-20261106-190000-fffffff1')
})

test('같은 이름이라도 다른 서버의 run 은 나중 run 판정에 섞이지 않는다 (리뷰 F4)', () => {
  const a = fakeRun('fx-20261106-200000-aaaaaab1', ['same.xml'], { upload: 1000, done: true })
  const other = { ...target, connection: { ...target.connection, host: 'b.invalid' } }
  const bDir = `${tmp}/runs/fx-20261106-200001-aaaaaab2`
  mkdirSync(bDir, { recursive: true })
  writeFileSync(`${bDir}/meta.env`, 'RUN_TARGET=fx\nBASE=b\nTIP=t\nHEADC=h\n')
  writeFileSync(`${bDir}/target.json`, JSON.stringify(other))
  writeFileSync(`${bDir}/errors.txt`, '')
  writeFileSync(`${bDir}/plan.tsv`, `M\t${repoMsys}/src/main/webapp/same.xml\t/app/same.xml\taaa\tbbb\t\n`)
  writeFileSync(`${bDir}/plan.done`, 'x\n')
  writeFileSync(`${bDir}/upload.started`, 'x\n2000\n')
  writeFileSync(`${bDir}/upload.done`, '2026-11-06 20:00:02\n')
  assert.ok(!laterOverlaps(a).some((x) => x.run === 'fx-20261106-200001-aaaaaab2'))
})

test('다른 계정(지문)의 나중 run 은 되돌리기를 막지 않고, 같은 계정·지문 없는 run 은 지금처럼 막는다', () => {
  const X = '1111111111111111'
  const Y = '2222222222222222'
  // 계정마다 루트(chroot)가 다를 수 있다: 다른 지문의 run 은 같은 경로라도 다른 파일을 건드렸다.
  const a = fakeRun('fx-20261110-100000-acc00001', ['acc1.xml'], { upload: 1000, done: true, account: X })
  const b = fakeRun('fx-20261110-100001-acc00002', ['acc1.xml'], { upload: 2000, done: true, account: Y })
  assert.deepEqual(laterOverlaps(a).map((x) => x.run), [], `다른 계정의 ${b.id} 는 나중 run 이 아님`)
  // 같은 지문
  const c = fakeRun('fx-20261110-100002-acc00003', ['acc2.xml'], { upload: 1000, done: true, account: X })
  const d = fakeRun('fx-20261110-100003-acc00004', ['acc2.xml'], { upload: 2000, done: true, account: X })
  assert.deepEqual(laterOverlaps(c).map((x) => x.run), [d.id])
  // 지문 없는 run 은 같은 계정으로 본다(양쪽 방향)
  const e = fakeRun('fx-20261110-100004-acc00005', ['acc3.xml'], { upload: 1000, done: true })
  const f = fakeRun('fx-20261110-100005-acc00006', ['acc3.xml'], { upload: 2000, done: true, account: Y })
  assert.deepEqual(laterOverlaps(e).map((x) => x.run), [f.id])
  const g = fakeRun('fx-20261110-100006-acc00007', ['acc4.xml'], { upload: 1000, done: true, account: X })
  const h = fakeRun('fx-20261110-100007-acc00008', ['acc4.xml'], { upload: 2000, done: true })
  assert.deepEqual(laterOverlaps(g).map((x) => x.run), [h.id])
})

test('계정 지문: 호스트·포트·사용자 이름으로 만들고, 비밀번호와 이름 그대로는 담지 않는다', async () => {
  const { accountMark } = await import('../src/engine/account.ts')
  const t = { ...target, connection: { ...target.connection, host: 'FTP.Example.com', port: 2121 } }
  const want = (user: string) => sha256(`prod-deploy account\nftp.example.com:2121\n${user}`).slice(0, 16)
  const m = accountMark(t, { kind: 'user', user: 'alice', password: 'secret' })
  assert.equal(m, want('alice'))
  assert.match(m, /^[0-9a-f]{16}$/)
  assert.equal(accountMark(t, { kind: 'user', user: 'alice', password: 'other' }), m, '비밀번호는 지문에 들지 않음')
  assert.notEqual(accountMark(t, { kind: 'user', user: 'bob', password: 'secret' }), m)
  assert.notEqual(accountMark({ ...t, connection: { ...t.connection, port: 21 } }, { kind: 'user', user: 'alice', password: 'secret' }), m)
  // curl 이 보내는 사용자 이름을 글자 그대로 쓴다: 앞뒤 공백도 빼지 않고(재검토 3-1), 대소문자도 그대로
  assert.notEqual(accountMark(t, { kind: 'user', user: ' alice ', password: 'x' }), m)
  assert.notEqual(accountMark(t, { kind: 'user', user: 'team', password: 'x' }), accountMark(t, { kind: 'user', user: 'team ', password: 'x' }))
  assert.equal(accountMark(t, { kind: 'user', user: 'team ', password: 'x' }), want('team '))
  assert.notEqual(accountMark(t, { kind: 'user', user: 'Alice', password: 'x' }), m)
})


test('netrc 읽기: 엔진이 대상 호스트의 login·password 를 정한다(주석·따옴표·macdef·default)', async () => {
  const { parseNetrc } = await import('../src/engine/netrc.ts')
  const read = (text: string, host = 'ftp.example.com') => parseNetrc(text, host, 'test.netrc')
  assert.deepEqual(read('machine ftp.example.com login alice password s3cret\n'), { user: 'alice', password: 's3cret' })
  // 줄 머리 # 주석(항목 안의 주석 줄 포함), 여러 줄 항목, 호스트·키워드 대소문자 무시, CRLF
  assert.deepEqual(read('# FTP accounts\r\nMACHINE FTP.Example.com\r\n  # 메모\r\n  LOGIN alice\r\n  password p\r\n'), { user: 'alice', password: 'p' })
  // 큰따옴표 값: 안의 공백과 \ 이스케이프. login fa-x 와 login "fa-x" 는 같다
  assert.deepEqual(read('machine ftp.example.com login "fa-x" password "p login first q"\n'), { user: 'fa-x', password: 'p login first q' })
  assert.deepEqual(read('machine ftp.example.com login "team one" password "a\\"b\\\\c"\n'), { user: 'team one', password: 'a"b\\c' })
  // 비밀번호 값은 키워드로 읽지 않는다
  assert.deepEqual(read('machine ftp.example.com password login login alice\n'), { user: 'alice', password: 'login' })
  // 다른 호스트 항목의 값이 키워드 같은 낱말이어도 값이다(재검토 1)
  assert.deepEqual(read('machine elsewhere login macdef password p\nmachine ftp.example.com login alice password q\n'), { user: 'alice', password: 'q' })
  // 항목 밖 macdef 본문(빈 줄·공백만 있는 줄까지)의 가짜 항목은 읽지 않는다. U+00A0 만 있는 줄은 빈 줄이 아니다
  assert.deepEqual(read('macdef init\nmachine ftp.example.com login evil password e\n  \nmachine ftp.example.com login alice password p\n'), { user: 'alice', password: 'p' })
  assert.deepEqual(read('macdef init\n \nmachine ftp.example.com login evil password e\n\nmachine ftp.example.com login alice password p\n'), { user: 'alice', password: 'p' })
  assert.deepEqual(read('machine ftp.example.com login alice password p\nmacdef init\ncd /x\n\n'), { user: 'alice', password: 'p' }, '다 적은 항목 뒤의 macdef')
  // 맞는 machine 이 없으면 default, 둘 다 맞으면 machine
  assert.deepEqual(read('machine other login o password o\ndefault login dflt password d\n'), { user: 'dflt', password: 'd' })
  assert.deepEqual(read('default login dflt password d\nmachine ftp.example.com login alice password p\n'), { user: 'alice', password: 'p' })
  // UTF-8 BOM 은 무시한다
  assert.deepEqual(read('﻿machine ftp.example.com login alice password p\n'), { user: 'alice', password: 'p' })
})

test('netrc 읽기: 이상한 모양은 고르지 않고 멈춘다(줄 번호와 이유만, 값은 적지 않음)', async () => {
  const { parseNetrc } = await import('../src/engine/netrc.ts')
  const secret = 'zz-secret-9d1'
  const stops = (text: string | Buffer, why: RegExp, host = 'ftp.example.com') =>
    assert.throws(
      () => parseNetrc(text, host, 'test.netrc'),
      (e: Error) => {
        assert.match(e.message, why)
        assert.ok(!e.message.includes(secret), `값이 문구에 나옴: ${e.message}`)
        assert.ok(!e.message.includes('alice'), `값이 문구에 나옴: ${e.message}`)
        return true
      }
    )
  const ok = `machine ftp.example.com login alice password ${secret}\n`
  stops(`${ok}machine ftp.example.com login bob password ${secret}\n`, /2행.*둘 이상/)
  stops(`machine ftp.example.com login alice password ${secret} login bob password q\n`, /1행.*login.*두 번/)
  stops(`machine ftp.example.com login alice password ${secret}\n password q\n`, /2행.*password.*두 번/)
  stops(`machine ftp.example.com login alice password ${secret} # 메모\n`, /1행.*모르는 낱말/)
  stops(`machine ftp.example.com login alice account a password ${secret}\n`, /1행.*모르는 낱말/)
  stops(`machine ftp.example.com login alice\nmacdef init\n\npassword ${secret}\n`, /2행.*macdef/)
  stops(`machine ftp.example.com macdef m\n\n${ok}`, /1행.*macdef/)
  stops(`${ok}machine unrelated login "unfinished\n`, /2행.*따옴표/, 'ftp.example.com')
  stops(`machine ftp.example.com login "alice\\tx" password ${secret}\n`, /1행.*제어 문자/)
  stops(`machine ftp.example.com login alice password ${secret}\u0001\n`, /1행.*제어 문자/)
  stops(`machine ftp.example.com login alice password\n`, /1행.*password.*값이 없음/)
  stops(`machine\n`, /1행.*호스트/)
  stops(`login alice password ${secret}\n`, /1행.*항목 밖/)
  stops(`machine other login alice password ${secret}\n`, /ftp\.example\.com.*항목이 없음/)
  stops(`machine ftp.example.com password ${secret}\n`, /login 이 없음/)
  stops(`machine ftp.example.com login alice\n`, /password 가 없음/)
  stops(Buffer.from([...Buffer.from('machine ftp.example.com login al'), 0x81, ...Buffer.from(` password ${secret}\n`)]), /UTF-8/)
  // 재검토 3-4: 따옴표 값 안의 실제 탭, C1 제어 문자(U+0080–U+009F, 주석·값 어디든), 빈 호스트
  stops(`machine ftp.example.com login "al\tice" password ${secret}\n`, /1행.*탭/)
  stops(`machine ftp.example.com login alice password "${secret}\tq"\n`, /1행.*탭/)
  stops(`# 메모\u0085\n${ok}`, /1행.*제어 문자/)
  stops(`machine ftp.example.com login alice password ${secret}\u009f\n`, /1행.*제어 문자/)
  stops(`machine "" login bob password q\ndefault login alice password ${secret}\n`, /1행.*호스트가 비었음/)
  // 구분자로 쓴 탭은 그대로 된다
  assert.deepEqual(parseNetrc(`machine\tftp.example.com\tlogin\talice\tpassword\t${secret}\n`, 'ftp.example.com', 'test.netrc'), { user: 'alice', password: secret })
  // 비UTF-8 은 그 줄 번호를 준다
  stops(Buffer.from([...Buffer.from(`# 첫 줄\nmachine ftp.example.com login al`), 0x81, ...Buffer.from(` password ${secret}\n`)]), /2행.*UTF-8/)
  // 재검토 4-2: 따옴표 안 \ 바로 뒤의 실제 탭(이스케이프를 푼 값에 탭이 남음) — login·password 두 칸
  stops(`machine ftp.example.com login "al\\\tice" password ${secret}\n`, /1행.*제어 문자/)
  stops(`machine ftp.example.com login alice password "${secret}\\\tq"\n`, /1행.*제어 문자/)
})

test('netrc 읽기: 파일 맨 처음의 BOM 만 빼고, 값 안의 U+FEFF 는 그대로 둔다 (재검토 4-3)', async () => {
  const { parseNetrc } = await import('../src/engine/netrc.ts')
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  const read = (b: Buffer) => parseNetrc(b, 'ftp.example.com', 'test.netrc')
  // 파일 맨 처음 BOM 은 뺀다
  assert.deepEqual(read(Buffer.concat([bom, Buffer.from('machine ftp.example.com login alice password p\n')])), { user: 'alice', password: 'p' })
  // login 다음 줄의 값이 U+FEFF 로 시작하면 그 글자를 이름에 둔다(줄 머리라도 빼지 않음)
  const mid = Buffer.concat([Buffer.from('machine ftp.example.com login\n'), bom, Buffer.from('name password p\n')])
  assert.deepEqual(read(mid), { user: '﻿name', password: 'p' })
  // 줄 번호 추적은 그대로: BOM 뒤 줄의 UTF-8 오류도 그 줄 번호
  stopsAt(Buffer.concat([bom, Buffer.from('# a\n# b\n'), Buffer.from([0x81]), Buffer.from('\n')]), /3행.*UTF-8/)
  function stopsAt(b: Buffer, why: RegExp) {
    assert.throws(() => read(b), (e: Error) => why.test(e.message))
  }
})

test('계정 지문은 보낸 사용자 이름으로만 만든다: 이름이 무엇이든 다른 이름과 겹치지 않고, 비밀번호만 바뀌면 같다 (재검토 3)', async () => {
  const { accountMark } = await import('../src/engine/account.ts')
  const { parseNetrc } = await import('../src/engine/netrc.ts')
  const t = { ...target, connection: { ...target.connection, host: 'ftp.example.com', port: 2121 } }
  const markOf = (text: string) => accountMark(t, { kind: 'user', ...parseNetrc(text, 'ftp.example.com', 'test.netrc') })
  const odd = 'netrc curl 8.19="alice" 8.21="bob"'
  const oddMark = markOf(`machine ftp.example.com login "netrc curl 8.19=\\"alice\\" 8.21=\\"bob\\"" password p\n`)
  assert.equal(oddMark, accountMark(t, { kind: 'user', user: odd, password: 'p' }))
  assert.notEqual(oddMark, markOf('machine ftp.example.com login alice password p\n'))
  assert.notEqual(oddMark, markOf('machine ftp.example.com login bob password p\n'))
  assert.equal(markOf('machine ftp.example.com login alice password one\n'), markOf('# 바꿈\nmachine ftp.example.com login "alice" password "two words"\n'))
})

/**
 * 자식 Node 에서 resolveAuth 를 부른다. 자격 증명 관리자(PowerShell) 호출만 가짜로 바꿔, 실제 자격 증명 관리자를 쓰지 않고
 * PD_FAKE_CRED(user, password) 를 저장된 값처럼 돌려준다. 결과는 'ok <같으면 same>' 또는 'stop <문구>' 한 줄.
 */
function resolveWithCred(user: string, password: string): string {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  const fake = `data:text/javascript,${encodeURIComponent(
    [
      "import cp from 'node:child_process'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const real = cp.spawn',
      'cp.spawn = (cmd, args, opts) => /powershell\\.exe$/i.test(String(cmd))',
      "  ? real(process.execPath, ['-e', \"process.stdin.resume();process.stdin.on('end',()=>console.log(process.env.PD_FAKE_CRED))\"], opts)",
      '  : real(cmd, args, opts)',
      'syncBuiltinESMExports()'
    ].join('\n')
  )}`
  const ftp = new URL('../src/engine/ftp.ts', import.meta.url).href
  const script = [
    `const { resolveAuth } = await import(${JSON.stringify(ftp)})`,
    "const t = { id: 'cred-fake', connection: { protocol: 'ftp', host: 'ftp.example.com', port: 21, root: '/' } }",
    'try {',
    '  const a = await resolveAuth(t)',
    "  console.log('ok ' + (a.user === process.env.PD_WANT_USER && a.password === process.env.PD_WANT_PASSWORD ? 'same' : 'different'))",
    "} catch (e) { console.log('stop ' + e.message) }"
  ].join('\n')
  const r = spawnSync(process.execPath, ['--import', fake, '--input-type=module', '-e', script], {
    env: { ...process.env, PD_FAKE_CRED: `ok ${b64(user)} ${b64(password)}`, PD_WANT_USER: user, PD_WANT_PASSWORD: password },
    encoding: 'utf8'
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

/**
 * 자식 Node 에서 Ftp 를 부른다. curl 실행만 가짜로 바꿔(PD_FAKE_ERR 를 stderr 로 내고 PD_FAKE_CODE 로 끝남) 비밀번호 password
 * 로 probe·exists(목록 실패 → Stop)·connVerdict 를 돌리고, 로그·probe 반환·Stop 문구·패널 문구를 JSON 한 줄로 돌려준다.
 */
function fakeCurl(password: string, err: string, code: number): { logs: string[]; probe: string; stop: string; verdict: string } {
  const fake = `data:text/javascript,${encodeURIComponent(
    [
      "import cp from 'node:child_process'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const real = cp.spawn',
      "cp.spawn = (cmd, args, opts) => String(cmd) === 'curl'",
      "  ? real(process.execPath, ['-e', \"process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write(process.env.PD_FAKE_ERR);process.exit(Number(process.env.PD_FAKE_CODE))})\"], opts)",
      '  : real(cmd, args, opts)',
      'syncBuiltinESMExports()'
    ].join('\n')
  )}`
  const url = (p: string) => JSON.stringify(new URL(p, import.meta.url).href)
  const script = [
    `const { Ftp } = await import(${url('../src/engine/ftp.ts')})`,
    `const { connVerdict } = await import(${url('../src/conn-verdict.ts')})`,
    "const t = { id: 'fake', label: 'FAKE', connection: { protocol: 'ftp', host: 'ftp.example.com', port: 21, root: '/app' } }",
    'const logs = []',
    "const ftp = new Ftp(t, { kind: 'user', user: 'u', password: process.env.PD_FAKE_PASSWORD }, (s) => logs.push(s))",
    "const p = await ftp.probe('/app', 5)",
    "let stop = ''",
    "try { await ftp.exists('/app/x/f.txt') } catch (e) { stop = e.message }",
    'console.log(JSON.stringify({ logs, probe: JSON.stringify(p), stop, verdict: connVerdict(t, p, 5).message }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['--import', fake, '--input-type=module', '-e', script], {
    env: { ...process.env, PD_FAKE_ERR: err, PD_FAKE_CODE: String(code), PD_FAKE_PASSWORD: password },
    encoding: 'utf8'
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').pop()!)
}

test('curl 오류: 가린 글자를 로그·Stop 문구·probe 반환·패널 문구가 함께 쓴다(비밀번호 값 없음) (재검토 4-1)', () => {
  const secret = 'zz-Secret-41c9'
  const err = `> USER u\r\n> PASS ${secret}\r\ncurl: (56) Recv failure near ${secret}\n`
  const got = fakeCurl(secret, err, 56)
  const all = [...got.logs, got.probe, got.stop, got.verdict]
  assert.ok(got.logs.length > 0 && got.stop && got.verdict, JSON.stringify({ ...got, logs: got.logs.length }))
  for (const s of all) assert.ok(!s.includes(secret), '비밀번호가 남음')
  assert.match(got.verdict, /curl: \(56\)/, '오류 줄 자체는 패널에 보임')
  assert.match(got.stop, /curl 56/)
})

test('curl 오류: 짧은 비밀번호를 가려도 로그에 curl 종료 코드가 보인다 (재검토 4-4)', () => {
  const got = fakeCurl('5', 'curl: (55) Failed sending data to the peer\n', 55)
  assert.ok(got.logs.some((l) => /curl 종료 55:/.test(l)), JSON.stringify(got.logs))
})

test('curl 오류: 비밀번호와 같은 글자가 오류 글자에 있으면 조각을 남기지 않고 통째로 숨기고, 종료 코드는 보인다 (Claude 검토 1)', () => {
  // 비밀번호 3 은 서버 응답 530 의 한 글자다: 그 자리만 가리면 5***0 처럼 남아 값을 짐작할 수 있다.
  const got = fakeCurl('3', 'curl: (67) Access denied: 530\n', 67)
  const all = [...got.logs, got.probe, got.stop, got.verdict]
  for (const s of all) {
    assert.ok(!s.includes('530'), `원문이 남음: ${s}`)
    assert.ok(!s.includes('***'), `가린 자리 조각이 남음: ${s}`)
  }
  assert.ok(got.logs.some((l) => /^curl 종료 67: /.test(l)), JSON.stringify(got.logs))
  assert.match(got.stop, /curl 67/)
  assert.match(got.verdict, /^로그인 실패 .*\[curl 67\]$/, '패널은 종료 코드로 고른 문구')
})

test('접속 정보: 사용자 이름에 콜론이 있으면 자격 증명 관리자·netrc 어느 쪽이든 멈춘다(값은 문구에 없음). 비밀번호의 콜론은 된다 (재검토 3-2)', async () => {
  const { parseNetrc } = await import('../src/engine/netrc.ts')
  // 자격 증명 관리자에서 읽은 값
  const stopped = resolveWithCred('al:ice', 'zz-secret-7')
  assert.match(stopped, /^stop .*사용자 이름에 콜론이 있음/)
  assert.ok(!stopped.includes('al:ice') && !stopped.includes('zz-secret-7'), stopped)
  assert.equal(resolveWithCred('alice', 'p:w:zz-secret-7'), 'ok same')
  // netrc 에서 읽은 값
  assert.throws(
    () => parseNetrc('machine ftp.example.com login al:ice password zz-secret-7\n', 'ftp.example.com', 'test.netrc'),
    (e: Error) => /1행.*사용자 이름에 콜론이 있음/.test(e.message) && !e.message.includes('al:ice') && !e.message.includes('zz-secret-7')
  )
  assert.deepEqual(parseNetrc('machine ftp.example.com login alice password p:w\n', 'ftp.example.com', 'test.netrc'), { user: 'alice', password: 'p:w' })
})

test('작업 기록: 프로세스 번호가 다른 프로세스에 다시 쓰여도, beat 가 멈췄으면 끝난 작업으로 본다', async () => {
  const { readJob, writeJob, JobWriter } = await import('../src/engine/jobs.ts')
  const old = Date.now() - 10 * 60000
  // 예전 CLI 가 남긴 기록(beat 없음). pid 는 지금 살아 있는 이 프로세스 — Orca 재시작 뒤 번호가 재사용된 경우.
  const base = { step: 'plan' as const, target: 'fx', run: null, spec: '#1', message: null, progress: null, lines: [], endedAt: null }
  writeJob({ ...base, id: 'stuck1', state: 'running', startedAt: old, pid: process.pid })
  assert.equal(readJob('stuck1')?.state, 'failed')
  // beat 가 2분 넘게 멈춤
  writeJob({ ...base, id: 'stuck2', state: 'running', startedAt: old, pid: process.pid, beat: Date.now() - 3 * 60000 })
  assert.equal(readJob('stuck2')?.state, 'failed')
  // beat 가 살아 있으면 오래 걸려도 도는 중
  writeJob({ ...base, id: 'alive1', state: 'running', startedAt: old, pid: process.pid, beat: Date.now() - 5000 })
  assert.equal(readJob('alive1')?.state, 'running')
  // JobWriter 는 시작할 때 beat 를 남기고, 끝나면 beat 타이머를 멈춘다(프로세스를 붙잡지 않음)
  const w = new JobWriter('writer1', { step: 'plan', target: 'fx', run: null, spec: '#1' })
  assert.ok((readJob('writer1')?.beat ?? 0) > Date.now() - 5000)
  w.finish(true, null)
  assert.equal(readJob('writer1')?.state, 'done')
})

test('run 숨기기: 화면에서만 빠지고 나중 run 판정에는 남는다, 부분 업로드는 숨기지 않는다', async () => {
  const { isHidden, setHidden } = await import('../src/engine/runs.ts')
  const a = fakeRun('fx-20261109-100000-abcabc01', ['hide.xml'], { upload: 5000, done: true })
  const b = fakeRun('fx-20261109-100001-abcabc02', ['hide.xml'], { upload: 6000, done: true })
  assert.equal(setHidden(b, true), true)
  assert.equal(isHidden(openRun(b.id)), true)
  assert.ok(listRuns(target).some((r) => r.id === b.id), '숨겨도 run 목록(안전 검사용)에는 있음')
  assert.ok(laterOverlaps(a).some((x) => x.run === b.id), '숨긴 나중 run 도 되돌리기를 막음')
  const p = fakeRun('fx-20261109-100002-abcabc03', ['p.xml'], { upload: 7000 })
  assert.equal(p.status(), 'partial')
  assert.equal(setHidden(p, true), false)
  assert.equal(isHidden(p), false)
  setHidden(b, false)
  assert.equal(isHidden(b), false)
})
