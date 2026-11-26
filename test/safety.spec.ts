// 리뷰(2026-11-06 Codex 1·2차)에서 나온 안전 문제의 회귀 시험. FTP 없이 run 기록·잠금·설정만으로 본다.
// 사용법: node --test test/safety.spec.ts
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

test('계정 지문: 호스트·포트·사용자 이름으로 만들고, 비밀번호와 이름 그대로는 담지 않는다. netrc 는 대상 호스트의 login 만 읽는다', async () => {
  const { accountMark } = await import('../src/engine/account.ts')
  const t = { ...target, connection: { ...target.connection, host: 'FTP.Example.com', port: 2121 } }
  const want = (user: string) => sha256(`prod-deploy account\nftp.example.com:2121\n${user}`).slice(0, 16)
  const m = accountMark(t, { kind: 'user', user: 'alice', password: 'secret' })
  assert.equal(m, want('alice'))
  assert.match(m, /^[0-9a-f]{16}$/)
  assert.equal(accountMark(t, { kind: 'user', user: 'alice', password: 'other' }), m, '비밀번호는 지문에 들지 않음')
  assert.notEqual(accountMark(t, { kind: 'user', user: 'bob', password: 'secret' }), m)
  assert.notEqual(accountMark({ ...t, connection: { ...t.connection, port: 21 } }, { kind: 'user', user: 'alice', password: 'secret' }), m)
  // netrc: 다른 호스트 항목은 건너뛰고, 여러 줄에 걸친 항목도 읽는다(호스트는 대소문자 무시)
  const netrc = `${tmp}/acc.netrc`
  writeFileSync(netrc, 'machine other.example login mallory password x\nmachine ftp.example.com\n  login alice\n  password secret\n')
  assert.equal(accountMark(t, { kind: 'netrc', file: netrc }), want('alice'))
  // 대상 호스트 항목이 없으면 netrc 경로로 대신한다
  writeFileSync(netrc, 'machine other.example login mallory password x\n')
  assert.equal(accountMark(t, { kind: 'netrc', file: netrc }), want(`netrc:${netrc}`))
})

test('계정 지문: netrc 는 curl 과 같은 뜻으로 읽는다(주석·따옴표·비밀번호 값·macdef·default)', async () => {
  const { accountMark } = await import('../src/engine/account.ts')
  const t = { ...target, connection: { ...target.connection, host: 'ftp.example.com', port: 2121 } }
  const want = (user: string) => sha256(`prod-deploy account\nftp.example.com:2121\n${user}`).slice(0, 16)
  const netrc = `${tmp}/curl.netrc`
  const markOf = (text: string) => {
    writeFileSync(netrc, text)
    return accountMark(t, { kind: 'netrc', file: netrc })
  }
  // 줄 머리 # 주석: 주석이 있는 두 계정은 서로 다른 지문
  const cx = markOf('# FTP accounts\nmachine ftp.example.com login fa-x password fa-x\n')
  const cy = markOf('# FTP accounts\nmachine ftp.example.com login fa-y password fa-y\n')
  assert.equal(cx, want('fa-x'))
  assert.equal(cy, want('fa-y'))
  assert.equal(markOf('machine ftp.example.com\n  # login evil\n  login fa-x password p\n'), want('fa-x'), '항목 안의 주석 줄도 무시')
  // 따옴표: login fa-x 와 login "fa-x" 는 같은 지문, 따옴표 안 \ 이스케이프와 공백
  assert.equal(markOf('machine ftp.example.com login "fa-x" password "fa-x"\n'), cx)
  assert.equal(markOf('machine ftp.example.com login "a\\"b\\\\c" password p\n'), want('a"b\\c'))
  const one = markOf('machine ftp.example.com login "team one" password p\n')
  const two = markOf('machine ftp.example.com login "team two" password p\n')
  assert.equal(one, want('team one'))
  assert.notEqual(one, two, '"team one" 과 "team two" 는 다른 계정')
  // 비밀번호만 바뀌면 같은 지문: 비밀번호 값(따옴표 안의 낱말 포함)은 login 으로 읽지 않는다
  const p1 = markOf('machine ftp.example.com password "p login first q" login fa-x\n')
  const p2 = markOf('machine ftp.example.com password "p login second q" login fa-x\n')
  assert.equal(p1, want('fa-x'))
  assert.equal(p2, p1)
  assert.equal(markOf('machine ftp.example.com login fa-x password login\n'), want('fa-x'), '비밀번호가 login 이라는 낱말이어도')
  // macdef 본문(빈 줄까지)의 가짜 machine/login 은 무시
  assert.equal(markOf('macdef init\nmachine ftp.example.com login evil password e\n\nmachine ftp.example.com login fa-x password p\n'), want('fa-x'))
  assert.equal(markOf('macdef init\r\nmachine ftp.example.com login evil password e\r\n  \r\nmachine ftp.example.com login fa-x password p\r\n'), want('fa-x'), '공백만 있는 줄도 macdef 끝(CRLF 포함)')
  // default: 맞는 machine 이 없으면 curl 처럼 default 의 login
  assert.equal(markOf('machine other.example login o password o\ndefault login fa-d password d\n'), want('fa-d'))
  // 같은 호스트가 둘이면 curl 처럼 앞(login·password 가 다 있는) 항목
  assert.equal(markOf('machine ftp.example.com login first password p1\nmachine ftp.example.com login second password p2\n'), want('first'))
  // 앞뒤 공백은 뺀다(대소문자는 그대로)
  assert.equal(accountMark(t, { kind: 'user', user: ' Alice ', password: 'x' }), want('Alice'))
  assert.notEqual(want('Alice'), want('alice'))
})

test('계정 지문: curl 판마다 다르게 읽는 netrc 는 두 해석을 함께 넣는다(같은 내용이면 같은 지문, login 을 바꾸면 다른 지문)', async () => {
  const { accountMark } = await import('../src/engine/account.ts')
  const t = { ...target, connection: { ...target.connection, host: 'ftp.example.com', port: 2121 } }
  const want = (user: string) => sha256(`prod-deploy account\nftp.example.com:2121\n${user}`).slice(0, 16)
  const netrc = `${tmp}/split.netrc`
  const markOf = (text: string) => {
    writeFileSync(netrc, text)
    return accountMark(t, { kind: 'netrc', file: netrc })
  }
  // login·password 를 다 찾은 뒤의 낱말: 8.19 는 거기서 멈추고(a), 8.21 은 항목 끝까지 읽어 뒤 login 을 쓴다(b).
  const split = (a: string, b: string) => `machine ftp.example.com login ${a} password p # login ${b} password q\n`
  const m1 = markOf(split('fa-x', 'fa-z'))
  assert.equal(markOf(split('fa-x', 'fa-z')), m1, '같은 내용이면 같은 지문')
  assert.notEqual(m1, want('fa-x'))
  assert.notEqual(m1, want('fa-z'))
  assert.notEqual(markOf(split('fa-y', 'fa-z')), m1, '앞 login 만 바꿔도 다른 지문')
  assert.notEqual(markOf(split('fa-x', 'fa-w')), m1, '뒤 login 만 바꿔도 다른 지문')
  // password 없는 같은 호스트 항목 뒤 다른 항목: 8.19 는 뒤 항목(second), 8.21 은 앞 항목(first)
  const dup = markOf('machine ftp.example.com login first\nmachine ftp.example.com login second password p\n')
  assert.notEqual(dup, want('first'))
  assert.notEqual(dup, want('second'))
})

test('계정 지문: 업로드에 고정한 netrc 사본은 OS 임시 폴더에 두고 release 로 지운다. 이름을 못 찾으면 원래 경로로 대신한다', async () => {
  const { accountMark, pinAccount } = await import('../src/engine/account.ts')
  const t = { ...target, connection: { ...target.connection, host: 'ftp.example.com', port: 2121 } }
  const netrc = `${tmp}/pin.netrc`
  writeFileSync(netrc, 'machine ftp.example.com login fa-x password p\n')
  const pinned = pinAccount(t, { kind: 'netrc', file: netrc })
  assert.equal(pinned.auth.kind, 'netrc')
  const copy = pinned.auth.kind === 'netrc' ? pinned.auth.file : ''
  assert.notEqual(copy, netrc)
  assert.ok(copy.startsWith(tmpdir()), copy)
  // 사본을 만든 뒤 원래 파일이 바뀌어도 그 업로드의 접속 정보·지문은 사본의 것
  writeFileSync(netrc, 'machine ftp.example.com login fa-y password p\n')
  assert.match(readFileSync(copy, 'utf8'), /login fa-x/)
  assert.equal(pinned.mark, accountMark(t, { kind: 'user', user: 'fa-x', password: '' }))
  pinned.release()
  assert.equal(existsSync(copy), false)
  writeFileSync(netrc, 'machine other.example login o password o\n')
  const other = pinAccount(t, { kind: 'netrc', file: netrc })
  assert.equal(other.mark, accountMark(t, { kind: 'netrc', file: netrc }), '대신 쓰는 경로는 원래 netrc 경로')
  other.release()
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
