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
const { toMsys } = await import('../src/engine/util.ts')

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
