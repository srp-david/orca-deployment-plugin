// 백업 정리(ADR 0006): 90일 지난 run 의 backup/ 만 지우고 기록은 남긴다. FTP 없이 run 폴더를 손으로 만들어 본다.
// 사용법: node --test test/prune.spec.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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
  if (o.uploadedRows !== undefined) {
    // 제품(steps.ts upload)이 남기는 것과 같은 줄: 시작, 올린 줄마다 [n/총] <운영 경로>, 다음 줄에서 멈춤.
    let log = `10:00:00 업로드 시작: ${t.label} ${files.length}개 (코드 x)\n`
    for (let i = 0; i < o.uploadedRows; i++) log += `10:00:01 [${i + 1}/${files.length}] /app/${files[i]}\n`
    log += `10:00:02 멈춤: 업로드 실패: /app/${files[o.uploadedRows]} (지금까지 ${o.uploadedRows}개 → 되돌리기)\n`
    writeFileSync(`${dir}/deploy.log`, log, { flag: 'a' })
  }
  return openRun(id)
}

function reset() {
  for (const t of [fx, fy, other]) rmSync(t.runs, { recursive: true, force: true })
}

const ids = (t = fx) => prunePlan(t, NOW).items.map((x) => x.id)

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
/** CLI 시험의 기준 시각: CLI 는 진짜 지금으로 판단하므로 run 나이도 시험을 시작한 시각에서 잰다(날짜가 지나도 같은 결과). */
const START = Date.now()
const agoNow = (days: number) => START - days * DAY
/** CLI 를 자식 프로세스로 부른다(같은 임시 PRODDEPLOY_HOME). */
function cli(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, PRODDEPLOY_HOME: `${tmp}/home` }, encoding: 'utf8' })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

/** 지금 목록의 확인 코드로 지운다(CLI 가 목록을 보고 --plan 을 주는 것과 같다). */
const pruneAll = () => pruneBackups(fx, { code: prunePlan(fx, NOW).code }, 'test', NOW)

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
  const r = pruneAll()
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
  assert.equal(b.uploadedCount(), 0)
  const p = prunePlan(fx, NOW)
  assert.deepEqual(p.items.map((x) => x.id), [], '운영의 a.jsp 는 아직 a 가 올린 것')
  assert.deepEqual(p.keptLatest, [a.id])
  pruneAll()
  assert.ok(openRun(a.id).has('backup'), '부분 업로드 run 과 그 직전 성공 백업은 함께 남는다')
  assert.ok(openRun(b.id).has('backup'))
})

test('일부만 올린(1/2) 부분 업로드 run 도 앞 run 의 보호를 풀지 않는다', () => {
  reset()
  const a = fakeRun(['b.jsp'], { upload: ago(200), verified: true })
  const a2 = fakeRun(['a.jsp'], { upload: ago(190), verified: true })
  const b = fakeRun(['a.jsp', 'b.jsp'], { upload: ago(150), done: false, uploadedRows: 1 })
  assert.equal(b.status(), 'partial')
  assert.equal(b.uploadedCount(), 1, 'a.jsp 한 줄은 다 올렸다')
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

test('다른 대상의 run 은 같은 호스트·포트·경로라도 이 대상 run 의 보호를 풀지 않는다', () => {
  reset()
  const a = fakeRun(['a.jsp'], { upload: ago(200), verified: true })
  fakeRun(['a.jsp'], { target: other, upload: ago(100), verified: true })
  assert.deepEqual(ids(), [], '다른 서버의 같은 경로는 다른 파일')
  // FTP 계정마다 루트(chroot)가 다를 수 있다: 같은 호스트·포트·경로라도 다른 대상이면 다른 파일일 수 있다.
  fakeRun(['a.jsp'], { target: fy, upload: ago(100), verified: true })
  assert.deepEqual(ids(), [])
  assert.deepEqual(prunePlan(fx, NOW).keptLatest, [a.id])
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
    assert.throws(() => pruneAll(), /다른 작업 중/)
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
  pruneAll()
  await assert.rejects(rollback(done.id, done.code(), true), /백업 지움.*되돌릴 수 없음/)
  await assert.rejects(upload(ready.id, ready.code(), true), /백업 지움.*올리지 않음/)
  await assert.rejects(backup(ready.id), /백업 지움.*다시 백업하지 않음/)
})

test('업로드한 run 의 plan.tsv 가 없거나, 비었거나, 줄이 깨졌으면 백업을 지우지 않고 이유를 보인다', () => {
  reset()
  const missing = fakeRun(['a.jsp'], { upload: ago(200), verified: true })
  rmSync(missing.path('plan.tsv'))
  const empty = fakeRun(['b.jsp'], { upload: ago(200), verified: true })
  writeFileSync(empty.path('plan.tsv'), '')
  const broken = fakeRun(['c.jsp'], { upload: ago(200), verified: true })
  writeFileSync(broken.path('plan.tsv'), 'M\t/c/repo/src/main/webapp/c.jsp\n')
  const noRemote = fakeRun(['d.jsp'], { upload: ago(200), done: true })
  writeFileSync(noRemote.path('plan.tsv'), 'M\t/c/repo/src/main/webapp/d.jsp\t\taaa\tbbb\t\n')
  const p = prunePlan(fx, NOW)
  assert.deepEqual(p.items.map((x) => x.id), [])
  const why = new Map(p.keptOther.map((x) => [x.id, x.reason]))
  for (const r of [missing, empty, broken, noRemote]) assert.match(why.get(r.id) ?? '', /plan\.tsv/, r.id)
  pruneAll()
  for (const r of [missing, empty, broken, noRemote]) assert.ok(openRun(r.id).has('backup'), r.id)
})

test('plan.tsv 가 깨진 업로드 run 은 다른 run 의 보호를 푸는 "나중 업로드"로 세지 않는다', () => {
  reset()
  const a = fakeRun(['a.jsp'], { upload: ago(200), verified: true })
  const b = fakeRun(['a.jsp'], { upload: ago(150), verified: true })
  writeFileSync(b.path('plan.tsv'), 'M\t/c/repo/src/main/webapp/a.jsp\t/app/a.jsp\taaa\tbbb\t\nM\t/c/repo/x\n')
  assert.deepEqual(ids(), [])
  assert.deepEqual(prunePlan(fx, NOW).keptLatest, [a.id])
})

test('CLI 목록(글자·--json)에 plan.tsv 가 깨져 남기는 이유가 보인다', () => {
  reset()
  const missing = fakeRun(['a.jsp'], { upload: agoNow(200), verified: true })
  rmSync(missing.path('plan.tsv'))
  const text = cli('prune', '--target', 'fx')
  assert.equal(text.code, 0, text.out)
  assert.match(text.out, new RegExp(`남김.*${missing.id}.*plan\\.tsv`))
  const json = cli('prune', '--target', 'fx', '--json')
  assert.equal(json.code, 0, json.out)
  const p = JSON.parse(json.out)
  assert.deepEqual(p.items, [])
  assert.equal(p.keptOther[0].id, missing.id)
  assert.match(p.keptOther[0].reason, /plan\.tsv/)
})

test('CLI: prune --yes 만으로는 지우지 않는다. 목록의 확인 코드를 --plan 으로 줘야 지운다', () => {
  reset()
  const old = fakeRun(['a.jsp'], { upload: agoNow(200), verified: true })
  fakeRun(['a.jsp'], { upload: agoNow(100), verified: true })
  const bare = cli('prune', '--target', 'fx', '--yes')
  assert.notEqual(bare.code, 0, bare.out)
  assert.match(bare.out, /다시 목록/)
  assert.ok(openRun(old.id).has('backup'), '--plan 없이는 아무것도 지우지 않음')
  const list = cli('prune', '--target', 'fx')
  const code = /확인 코드: ([0-9a-f]{8})/.exec(list.out)?.[1] ?? ''
  assert.ok(code, list.out)
  assert.match(list.out, new RegExp(`--plan ${code} --yes`))
  const done = cli('prune', '--target', 'fx', '--plan', code, '--yes')
  assert.equal(done.code, 0, done.out)
  assert.equal(openRun(old.id).has('backup'), false)
})

test('CLI: 목록을 본 뒤 지울 run 이 바뀌면(새 run 이 90일을 채움) 옛 확인 코드로는 지우지 않는다', () => {
  reset()
  const old = fakeRun(['a.jsp'], { upload: agoNow(200), verified: true })
  const mid = fakeRun(['a.jsp'], { upload: agoNow(50), verified: true })
  fakeRun(['a.jsp'], { upload: agoNow(10), verified: true })
  const list = cli('prune', '--target', 'fx')
  assert.match(list.out, new RegExp(old.id))
  const code = /확인 코드: ([0-9a-f]{8})/.exec(list.out)?.[1] ?? ''
  writeFileSync(mid.path('upload.started'), `x\n${agoNow(100)}\n`)
  const stale = cli('prune', '--target', 'fx', '--plan', code, '--yes')
  assert.notEqual(stale.code, 0, stale.out)
  assert.match(stale.out, /다시 목록/)
  assert.ok(openRun(old.id).has('backup') && openRun(mid.id).has('backup'), '아무것도 지우지 않음')
})

/** 디렉터리 정션을 만든다(Windows 는 관리자 권한 없이 된다). 만들 수 없는 환경이면 false — 그 시험은 건너뛴다. */
function junction(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'junction')
    return true
  } catch {
    return false
  }
}

/** 임시 폴더 안에 run 기록 폴더 바깥 자리를 새로 만든다. */
function outsideDir(name: string): string {
  const d = `${tmp}/outside/${name}`
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true })
  return d
}

test('run 폴더 자리의 정션이 가리키는 바깥 run 의 백업은 지우지 않고 이유를 보인다', (t) => {
  reset()
  const run = fakeRun(['a.jsp'], { upload: ago(200), rolledBack: true }) // 되돌린 run: 제자리면 지울 목록에 든다
  const out = `${outsideDir('run')}/${run.id}`
  renameSync(run.dir, out)
  if (!junction(out, run.dir)) return t.skip('정션을 만들 수 없는 환경')
  const p = prunePlan(fx, NOW)
  assert.deepEqual(p.items.map((x) => x.id), [])
  assert.match(p.keptOther.find((x) => x.id === run.id)?.reason ?? '', /링크/)
  pruneAll()
  assert.ok(existsSync(`${out}/backup/files/a.jsp`), '바깥 run 의 백업이 남음')
})

test('backup 폴더가 정션이면 따라가지 않고 남긴다', (t) => {
  reset()
  const run = fakeRun(['a.jsp'], { upload: ago(200), rolledBack: true })
  const out = outsideDir('backup')
  mkdirSync(`${out}/files`)
  writeFileSync(`${out}/files/keep.jsp`, 'k')
  rmSync(run.path('backup'), { recursive: true })
  if (!junction(out, run.path('backup'))) return t.skip('정션을 만들 수 없는 환경')
  const p = prunePlan(fx, NOW)
  assert.deepEqual(p.items.map((x) => x.id), [])
  assert.match(p.keptOther.find((x) => x.id === run.id)?.reason ?? '', /링크/)
  pruneAll()
  assert.ok(existsSync(`${out}/files/keep.jsp`))
})

test('백업 안의 정션은 따라가지 않는다: 바깥 파일은 크기에 들지 않고 지워지지 않는다(순환 링크 포함)', (t) => {
  reset()
  const run = fakeRun(['a.jsp'], { upload: ago(200), rolledBack: true })
  const out = outsideDir('inner')
  writeFileSync(`${out}/big.bin`, 'y'.repeat(5000))
  if (!junction(out, run.path('backup/files/out'))) return t.skip('정션을 만들 수 없는 환경')
  assert.ok(junction(run.path('backup'), run.path('backup/files/loop')), '순환 정션')
  const p = prunePlan(fx, NOW)
  assert.deepEqual(p.items.map((x) => x.id), [run.id])
  assert.equal(p.items[0].bytes, 1000, '백업 자신의 파일만 센다')
  pruneAll()
  assert.equal(existsSync(run.path('backup')), false)
  assert.ok(existsSync(`${out}/big.bin`), '바깥 파일은 남음')
})

test('한 run 의 백업 삭제가 실패해도 나머지는 지우고, 실패를 돌려주고 로그에 남기며, 다음 정리에서 남은 백업을 지운다', async () => {
  reset()
  const stuck = fakeRun(['a.jsp', 'b.jsp'], { backupAt: ago(300) }) // 먼저 지우는 run
  const next = fakeRun(['c.jsp'], { backupAt: ago(200) })
  const busy = (p: string) => {
    if (p === stuck.path('backup')) {
      // 파일 하나를 지운 뒤 잠긴 파일에서 멈춘다(탐색기·백신이 잡고 있을 때처럼)
      rmSync(join(p, 'files', 'a.jsp'))
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${join(p, 'files', 'b.jsp')}'`), { code: 'EBUSY' })
    }
    rmSync(p, { recursive: true, force: true })
  }
  const r = pruneBackups(fx, { code: prunePlan(fx, NOW).code }, 'test', NOW, busy)
  assert.deepEqual(r.pruned.map((x) => x.id), [next.id], '다음 run 은 지움')
  assert.equal(existsSync(next.path('backup')), false)
  assert.deepEqual(r.failed.map((x) => x.id), [stuck.id])
  assert.match(r.failed[0].error, /b\.jsp/, '오류에 경로가 있음')
  const run = openRun(stuck.id)
  assert.match(run.text('deploy.log'), /백업 정리 중 실패\(일부 남음\).*b\.jsp/)
  assert.ok(existsSync(run.path('backup/files/b.jsp')), '일부 남음')
  // 지우는 중인 run 은 지운 run 처럼 되돌리기·업로드·다시 백업을 막는다
  assert.ok(run.backupPruned())
  await assert.rejects(rollback(run.id, run.code(), true), /백업 지움/)
  await assert.rejects(upload(run.id, run.code(), true), /백업 지움/)
  await assert.rejects(backup(run.id), /백업 지움/)
  // 다음 정리: 남은 백업을 다시 지운다
  assert.deepEqual(ids(), [stuck.id])
  const again = pruneAll()
  assert.deepEqual(again.pruned.map((x) => x.id), [stuck.id])
  assert.deepEqual(again.failed, [])
  assert.equal(existsSync(run.path('backup')), false)
  assert.match(openRun(stuck.id).text('deploy.log'), /백업 정리: 90일 지남/)
  assert.ok(openRun(stuck.id).backupPruned())
  assert.deepEqual(ids(), [], '다 지운 뒤에는 다시 나오지 않음')
})
