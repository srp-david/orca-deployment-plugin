// 백업 정리(ADR 0006): 90일 지난 run 의 backup/ 만 지우고 기록은 남긴다. FTP 없이 run 폴더를 손으로 만들어 본다.
// 사용법: node --test test/prune.spec.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'pd-prune-')).replace(/\\/g, '/')
process.env.PRODDEPLOY_HOME = `${tmp}/home`

const { acquireLock, openRun } = await import('../src/engine/runs.ts')
const { prunePlan, pruneBackups } = await import('../src/engine/prune.ts')
const { backup, rollback, upload } = await import('../src/engine/steps.ts')
const { saveTarget } = await import('../src/engine/target.ts')

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime()
const ago = (days: number) => NOW - days * DAY

function makeTarget(id: string, host = '127.0.0.1', port = 2121) {
  const t = {
    id,
    label: id.toUpperCase(),
    repo: `${tmp}/repo`,
    runs: `${tmp}/runs-${id}`,
    connection: { protocol: 'ftp' as const, host, port, root: '/app' },
    mappings: [{ local: 'src/main/webapp', remote: '/' }],
    manual: []
  }
  saveTarget(t)
  return t
}

const fx = makeTarget('fx')
const fy = makeTarget('fy')
const other = makeTarget('fo', 'ftp.other.example')

type Fake = {
  target?: typeof fx
  /** 업로드 시작 시각(ms). 없으면 올리지 않은 run. 'bash' 면 날짜 없는 bash 시절 부분 업로드. */
  upload?: number | 'bash'
  /** 백업 받은 시각(ms). */
  backupAt?: number
  done?: boolean
  verified?: boolean
  rolledBack?: boolean
  /** 부분 업로드에서 올린 줄 수(로그에 [n/총] 줄을 남김). 다음 줄에서 업로드 실패로 멈춘 것으로 친다. */
  uploadedRows?: number
}

let seq = 0
/** run 폴더를 손으로 만든다. files 는 운영 루트 아래 경로(덮어씀). */
function fakeRun(files: string[], o: Fake = {}) {
  const t = o.target ?? fx
  const id = `${t.id}-20260101-${String(100000 + seq++).slice(-6)}-abcdef12`
  const dir = `${t.runs}/${id}`
  mkdirSync(`${dir}/backup/files`, { recursive: true })
  writeFileSync(`${dir}/meta.env`, `RUN_TARGET=${t.id}\nBASE=b\nTIP=t\nHEADC=h\n`)
  writeFileSync(`${dir}/target.json`, JSON.stringify(t))
  writeFileSync(`${dir}/errors.txt`, '')
  writeFileSync(`${dir}/plan.tsv`, files.map((f) => `M\t/c/repo/src/main/webapp/${f}\t/app/${f}\taaa\tbbb\t\n`).join(''))
  writeFileSync(`${dir}/plan.done`, 'x\n')
  writeFileSync(`${dir}/deploy.log`, `10:00:00 plan: ${id} 반영 (기준 b)\n`)
  writeFileSync(`${dir}/backup.layout`, 'v2\n')
  for (const f of files) writeFileSync(`${dir}/backup/files/${f}`, 'x'.repeat(1000))
  const d = new Date(o.backupAt ?? (typeof o.upload === 'number' ? o.upload : ago(100)))
  const p = (n: number) => String(n).padStart(2, '0')
  writeFileSync(`${dir}/backup.done`, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}\n`)
  if (o.upload === 'bash') writeFileSync(`${dir}/deploy.log`, '10:00:00 업로드 시작: x\n10:00:01 [1/2] /app/a\n', { flag: 'a' })
  else if (o.upload) writeFileSync(`${dir}/upload.started`, `x\n${o.upload}\n`)
  if (o.done !== false && typeof o.upload === 'number') writeFileSync(`${dir}/upload.done`, 'x\n')
  if (o.verified) writeFileSync(`${dir}/verify.done`, 'x\n')
  if (o.rolledBack) writeFileSync(`${dir}/rollback.done`, 'x\n')
  return openRun(id)
}

function reset() {
  for (const t of [fx, fy, other]) rmSync(t.runs, { recursive: true, force: true })
}

const ids = (t = fx) => prunePlan(t, NOW).items.map((x) => x.id)

test('90일 지난 run 은 지우고, 90일 안 된 run 은 남긴다', () => {
  reset()
  const old = fakeRun(['a.jsp'], { upload: ago(120), verified: true })
  const young = fakeRun(['a.jsp'], { upload: ago(30), verified: true })
  assert.deepEqual(ids(), [old.id])
  const p = prunePlan(fx, NOW)
  assert.equal(p.items[0].bytes, 1000)
  assert.equal(p.items[0].statusLabel, '대조됨')
  assert.ok(!p.keptLatest.includes(young.id), '90일 안 된 run 은 남김 목록에도 없다')
})

test('지우면 backup/ 만 없어지고 기록·상태는 남으며, 표시와 로그가 생긴다', () => {
  reset()
  const old = fakeRun(['a.jsp'], { upload: ago(120), verified: true })
  fakeRun(['a.jsp'], { upload: ago(10), verified: true })
  const r = pruneBackups(fx, null, 'test', NOW)
  assert.deepEqual(r.pruned.map((x) => x.id), [old.id])
  const run = openRun(old.id)
  assert.equal(existsSync(run.path('backup')), false)
  assert.ok(run.has('plan.tsv') && run.has('backup.done'))
  assert.equal(run.status(), 'verified', '상태는 그대로')
  assert.match(run.backupPruned() ?? '', /^\d{4}-\d{2}-\d{2} /)
  assert.match(run.text('deploy.log'), /백업 정리: 90일 지남/)
  assert.deepEqual(ids(), [], '다시 지울 것은 없다')
})

test('어느 운영 파일이든 마지막으로 올린 run 은 90일이 지나도 남긴다', () => {
  reset()
  const a = fakeRun(['a.jsp', 'b.jsp'], { upload: ago(200), verified: true })
  const b = fakeRun(['a.jsp'], { upload: ago(150), verified: true })
  // a 의 b.jsp 는 그 뒤 아무도 올리지 않았다: a 가 b.jsp 의 마지막 run.
  const p = prunePlan(fx, NOW)
  assert.deepEqual(p.items.map((x) => x.id), [])
  assert.deepEqual(p.keptLatest.sort(), [a.id, b.id].sort())
  const c = fakeRun(['b.jsp'], { upload: ago(100), verified: true })
  assert.deepEqual(ids(), [a.id], '이제 a 는 어느 파일의 마지막도 아니다')
  assert.deepEqual(prunePlan(fx, NOW).keptLatest.sort(), [b.id, c.id].sort())
})

test('되돌린 run 은 "마지막 run" 으로 치지 않고, 그 자신도 90일이 지나면 지운다', () => {
  reset()
  const a = fakeRun(['a.jsp'], { upload: ago(200), verified: true })
  const b = fakeRun(['a.jsp'], { upload: ago(150), rolledBack: true })
  const p = prunePlan(fx, NOW)
  assert.deepEqual(p.items.map((x) => x.id), [b.id])
  assert.deepEqual(p.keptLatest, [a.id], '지금 운영의 a.jsp 는 a 가 올린 것')
})

test('부분 업로드 run 과 업로드 시각을 모르는 run 은 넣지 않는다', () => {
  reset()
  const partial = fakeRun(['a.jsp'], { upload: ago(200), done: false })
  const bash = fakeRun(['b.jsp'], { upload: 'bash' })
  assert.equal(partial.status(), 'partial')
  assert.equal(bash.uploadAt(), 'unknown')
  assert.deepEqual(ids(), [])
})

test('첫 파일에서 실패한(0/1) 부분 업로드 run 은 앞 run 의 보호를 풀지 않는다', () => {
  reset()
  const a = fakeRun(['a.jsp'], { upload: ago(200), verified: true })
  const b = fakeRun(['a.jsp'], { upload: ago(150), done: false, uploadedRows: 0 })
  assert.equal(b.status(), 'partial')
  const p = prunePlan(fx, NOW)
  assert.deepEqual(p.items.map((x) => x.id), [], '운영의 a.jsp 는 아직 a 가 올린 것')
  assert.deepEqual(p.keptLatest, [a.id])
  pruneBackups(fx, null, 'test', NOW)
  assert.ok(openRun(a.id).has('backup'), '부분 업로드 run 과 그 직전 성공 백업은 함께 남는다')
  assert.ok(openRun(b.id).has('backup'))
})

test('일부만 올린(1/2) 부분 업로드 run 도 앞 run 의 보호를 풀지 않는다', () => {
  reset()
  const a = fakeRun(['b.jsp'], { upload: ago(200), verified: true })
  const a2 = fakeRun(['a.jsp'], { upload: ago(190), verified: true })
  fakeRun(['a.jsp', 'b.jsp'], { upload: ago(150), done: false, uploadedRows: 1 })
  assert.deepEqual(ids(), [])
  assert.deepEqual(prunePlan(fx, NOW).keptLatest.sort(), [a.id, a2.id].sort())
})

test('올리지 않은 run 은 백업을 받은 시각으로 잰다', () => {
  reset()
  const old = fakeRun(['a.jsp'], { backupAt: ago(95) })
  fakeRun(['a.jsp'], { backupAt: ago(20) })
  assert.equal(old.status(), 'backedUp')
  assert.deepEqual(ids(), [old.id])
})

test('같은 서버를 쓰는 다른 대상이 나중에 올린 파일도 본다. 다른 서버는 보지 않는다', () => {
  reset()
  const a = fakeRun(['a.jsp'], { upload: ago(200), verified: true })
  fakeRun(['a.jsp'], { target: other, upload: ago(100), verified: true })
  assert.deepEqual(ids(), [], '다른 서버의 같은 경로는 다른 파일')
  fakeRun(['a.jsp'], { target: fy, upload: ago(100), verified: true })
  assert.deepEqual(ids(), [a.id])
  assert.deepEqual(ids(fy), [], 'fy 의 run 은 fy 를 정리할 때만, 그리고 마지막 run 이라 남김')
})

test('ids 를 주면 그중 지금도 지울 수 있는 것만 지운다', () => {
  reset()
  const a = fakeRun(['a.jsp'], { upload: ago(300), verified: true })
  const b = fakeRun(['a.jsp'], { upload: ago(200), verified: true })
  fakeRun(['a.jsp'], { upload: ago(10), verified: true })
  const young = fakeRun(['b.jsp'], { backupAt: ago(5) })
  const r = pruneBackups(fx, [b.id, young.id], 'test', NOW)
  assert.deepEqual(r.pruned.map((x) => x.id), [b.id])
  assert.deepEqual(r.skipped, [young.id])
  assert.ok(openRun(a.id).has('backup'), '보지 않은 run 은 지우지 않음')
})

test('다른 작업이 대상을 잠그고 있으면 지우지 않는다', () => {
  reset()
  const a = fakeRun(['a.jsp'], { upload: ago(300), verified: true })
  fakeRun(['a.jsp'], { upload: ago(10), verified: true })
  const release = acquireLock({ target: 'fx', run: 'x', step: 'upload', by: 't' })
  try {
    assert.throws(() => pruneBackups(fx, null, 'test', NOW), /다른 작업 중/)
  } finally {
    release()
  }
  assert.ok(openRun(a.id).has('backup'))
})

test('백업을 지운 run 은 되돌리기·업로드·다시 백업을 하지 않는다', async () => {
  reset()
  const done = fakeRun(['a.jsp'], { upload: ago(300), verified: true })
  fakeRun(['a.jsp'], { upload: ago(10), verified: true })
  const ready = fakeRun(['b.jsp'], { backupAt: ago(100) })
  pruneBackups(fx, null, 'test', NOW)
  await assert.rejects(rollback(done.id, done.code(), true), /백업 지움.*되돌릴 수 없음/)
  await assert.rejects(upload(ready.id, ready.code(), true), /백업 지움.*올리지 않음/)
  await assert.rejects(backup(ready.id), /백업 지움.*다시 백업하지 않음/)
})
