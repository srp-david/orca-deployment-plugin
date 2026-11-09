// plan 뒤의 단계: 백업(운영 읽기) → 업로드(운영 쓰기) → 대조(운영 읽기), 되돌리기(운영 쓰기).
// 모두 대상 잠금 안에서 돌고, run 상태 검사도 잠금을 잡은 뒤에 한다. 업로드·되돌리기는 확인 코드가 맞아야 한다.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Ftp, resolveAuth } from './ftp.ts'
import { git, gitText } from './git.ts'
import { acquireLock, listRuns, openRun, type PlanRow, type Run } from './runs.ts'
import { configKey, loadTargetOrDeleted, mainBranch } from './target.ts'
import { dateTime, sha256, Stop, toMsys, toNative } from './util.ts'

export type StepHooks = {
  /** 사람에게 보여 줄 진행 줄(로그에도 남는다). */
  say?: (line: string) => void
  progress?: (n: number, total: number) => void
  /** 잠금에 남길 실행 주체(패널·CLI). */
  by?: string
}

function logger(run: Run, h: StepHooks) {
  return (s: string) => {
    run.log(s)
    h.say?.(s)
  }
}

function stop(run: Run, h: StepHooks, msg: string): never {
  logger(run, h)(`멈춤: ${msg}`)
  const e = new Stop(msg)
  e.reported = true
  throw e
}

function assertUsable(run: Run, h: StepHooks): void {
  const errors = run.errors()
  if (errors.length) stop(run, h, `막힌 run — ${errors[0]}${errors.length > 1 ? ` 외 ${errors.length - 1}건` : ''}`)
  if (!run.plan().length) stop(run, h, '올릴 파일이 없는 run')
}

/** run 에 남은 대상 설정과 지금 설정이 같은가. 다르면 그 run 은 지금 설정으로 만든 plan 이 아니다. */
export function configChanged(run: Run): boolean {
  if (!run.has('target.json')) return false
  try {
    return configKey(loadTargetOrDeleted(run.target.id)) !== configKey(run.target)
  } catch {
    return true
  }
}

type Dest = { host: string; port: number; root: string }

/** `ftp://호스트[:포트]/루트` → 호스트(소문자)·포트(없으면 21)·루트(대소문자 그대로, 끝 슬래시 뺌). 못 읽으면 null. */
export function parseFtpUrl(url: string): Dest | null {
  const m = /^ftp:\/\/([^/:\s]+)(?::(\d+))?(\/\S*)?$/i.exec(url.trim())
  if (!m) return null
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : 21, root: (m[3] ?? '/').replace(/\/+$/, '') || '/' }
}

const destOf = (t: Run['target']): Dest => ({
  host: t.connection.host.toLowerCase(),
  port: t.connection.port ?? 21,
  root: t.connection.root.replace(/\/+$/, '') || '/'
})

const sameDest = (a: Dest, b: Dest) => a.host === b.host && a.port === b.port && a.root === b.root

/** Windows 경로 비교용: 슬래시 통일, 끝 슬래시 뺌, 대소문자 무시. */
const winPath = (p: string) => toMsys(p).replace(/\/+$/, '').toLowerCase()

/**
 * bash 시절 run(설정 사본 target.json 없음)은 지금 설정으로 열린다. 그 설정이 run 을 만들 때와 같다는 보장이 없으므로,
 * 쓰기 전에 run 의 기록과 맞춰 본다: 로그 첫머리의 "대상: … → ftp://호스트/루트" 와 plan.tsv 의 저장소 경로.
 * 맞으면 그때 사본을 만들어 이후의 설정 변경을 잡고, 다르거나 기록이 없으면 이 run 에는 쓰지 않는다.
 */
function adoptLegacy(run: Run, h: StepHooks): Run {
  if (run.has('target.json')) return run
  const t = run.target
  const m = /대상: .* → (ftp:\/\/\S+)/.exec(run.text('deploy.log'))
  if (!m) stop(run, h, 'bash 시절 run 인데 대상 주소 기록이 없음 — 이 run 에는 쓰지 않음(새로 plan)')
  const logged = parseFtpUrl(m[1])
  const now = destOf(t)
  if (!logged || !sameDest(logged, now))
    stop(run, h, `bash 시절 run 의 대상 주소(${m[1]})가 지금 설정(ftp://${now.host}:${now.port}${now.root})과 다름 — 이 run 에는 쓰지 않음`)
  const repo = winPath(t.repo) + '/'
  const off = run.plan().find((r) => !winPath(r.local).startsWith(repo))
  if (off) stop(run, h, `bash 시절 run 의 로컬 경로(${off.local})가 지금 메인 체크아웃(${t.repo}) 밖 — 이 run 에는 쓰지 않음`)
  run.write('target.json', JSON.stringify(t, null, 2) + '\n')
  logger(run, h)('bash 시절 run: 기록된 대상 주소·저장소가 지금 설정과 같아 설정 사본(target.json)을 만듦')
  return openRun(run.id)
}

async function withLock<T>(id: string, step: string, h: StepHooks, body: (run: Run) => Promise<T>): Promise<T> {
  const run = openRun(id)
  const release = acquireLock({ target: run.target.id, run: run.id, step, by: h.by ?? 'cli' })
  try {
    // 잠금을 잡은 뒤에 run 을 다시 읽는다: 잡기 전의 상태로 판단하지 않도록.
    return await body(adoptLegacy(openRun(id), h))
  } catch (e) {
    if (e instanceof Stop && !e.reported) {
      logger(run, h)(`멈춤: ${e.message}`)
      e.reported = true
    } else if (!(e instanceof Stop)) run.log(`멈춤: 예상 못 한 오류 — ${(e as Error).message}`)
    throw e
  } finally {
    release()
  }
}

/** 백업이 온전한가: 덮어쓸 파일마다 백업이 있고 plan 때 운영 sha 와 같다. */
function checkBackup(run: Run, h: StepHooks): void {
  for (const r of run.plan()) {
    if (r.kind !== 'M') continue
    const f = run.backupPath(r.remote)
    if (!existsSync(f)) stop(run, h, `백업 파일이 없음: ${r.remote} — 다시 백업`)
    if (sha256(readFileSync(f)) !== r.rsha) stop(run, h, `백업 파일이 plan 때 운영본과 다름: ${r.remote} — 다시 백업`)
  }
}

/**
 * 덮어쓸 운영 파일을 받아 plan 때와 같은지 대조하고, 새 파일 자리는 아직 비었는지 본다.
 * 임시 폴더(backup.tmp)에 다 받고 검증한 뒤에 backup/ 과 바꾼다: 실패하면 완료 표시가 남지 않는다.
 */
export async function backup(id: string, h: StepHooks = {}): Promise<void> {
  await withLock(id, 'backup', h, async (run) => {
    const log = logger(run, h)
    assertUsable(run, h)
    if (run.uploadBegun()) stop(run, h, '이미 업로드를 시작한 run — 백업을 다시 받지 않음')
    if (configChanged(run)) stop(run, h, '대상 설정이 plan 이후 바뀜 — 새로 plan')
    run.remove('backup.done')
    const tmp = run.path('backup.tmp')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const ftp = new Ftp(run.target, await resolveAuth(run.target), (s) => run.log(s))
    const rows = run.plan()
    let bad = 0
    let n = 0
    const fresh: string[] = []
    for (const [i, r] of rows.entries()) {
      h.progress?.(i + 1, rows.length)
      if (r.kind === 'A') {
        if (await ftp.exists(r.remote)) {
          log(`새 파일 자리에 이미 생김: ${r.remote}`)
          bad++
        }
        fresh.push(r.remote)
        continue
      }
      const dest = run.backupPath(r.remote, 'backup.tmp')
      if (!(await ftp.get(r.remote, dest))) {
        log(`백업 실패: ${r.remote}`)
        bad++
        continue
      }
      if (sha256(readFileSync(dest)) !== r.rsha) {
        log(`plan 이후 운영 파일이 바뀜: ${r.remote}`)
        bad++
      }
      n++
    }
    if (bad) {
      rmSync(tmp, { recursive: true, force: true })
      stop(run, h, '백업 확인 실패 — 다시 plan')
    }
    writeFileSync(`${tmp}/new-files.txt`, fresh.map((x) => x + '\n').join(''), 'utf8')
    // 배치 표시는 run 폴더에: 백업 폴더 안에 두면 운영 파일 이름과 겹칠 수 있다.
    run.write('backup.layout', 'v2\n')
    rmSync(run.path('backup'), { recursive: true, force: true })
    renameSync(tmp, run.path('backup'))
    checkBackup(run, h)
    run.write('backup.done', dateTime() + '\n')
    log(`백업 완료: ${run.path('backup')} (덮어쓸 ${n}개 받음, 새 파일 ${fresh.length}개)`)
  })
}

function checkCode(run: Run, h: StepHooks, code: string, yes: boolean): void {
  if (!yes) stop(run, h, '--yes 가 필요함')
  if (code !== run.code()) stop(run, h, `확인 코드가 다름(받은 값 '${code}'). 사람이 승인한 plan 이 아니면 올리지 않는다`)
}

/**
 * 올릴 바이트를 run/stage/ 에 고정한다. 승인한 sha 와 같은 바이트만 떠 두고 업로드는 이 사본에서 한다:
 * 업로드 도중 IDE 빌드 등으로 로컬 파일이 바뀌어도 승인하지 않은 내용이 올라가지 않는다.
 */
function stage(run: Run, rows: PlanRow[], h: StepHooks): string[] {
  const dir = run.path('stage')
  rmSync(dir, { recursive: true, force: true })
  const out: string[] = []
  for (const [i, r] of rows.entries()) {
    const bytes = readFileSync(toNative(r.local))
    if (sha256(bytes) !== r.lsha) stop(run, h, `plan 이후 로컬 파일이 바뀜: ${r.local} — 새로 plan`)
    const f = `${dir}/${i}`
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, bytes)
    if (sha256(readFileSync(f)) !== r.lsha) stop(run, h, `고정본을 쓰지 못함: ${r.local}`)
    out.push(f)
  }
  return out
}

/** 업로드 직전 다시 확인: 브랜치·HEAD 가 plan 때와 같은지, 운영 파일이 plan·백업 때와 같은지. */
async function recheck(run: Run, ftp: Ftp, h: StepHooks): Promise<void> {
  const t = run.target
  const meta = run.meta()
  const branch = await gitText(t.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '?')
  if (branch !== mainBranch(t)) stop(run, h, `메인 체크아웃이 ${branch} — ${mainBranch(t)} 으로 바꾼 뒤 새로 plan`)
  const head = (await git(t.repo, ['rev-parse', 'HEAD'])).out.toString('utf8').trim()
  if (meta.HEADC && head !== meta.HEADC)
    stop(run, h, `메인 체크아웃 HEAD 가 plan 때(${meta.HEADC.slice(0, 8)})와 다름(${head.slice(0, 8)}) — 새로 plan`)
  for (const r of run.plan()) {
    if (r.kind === 'A') {
      if (await ftp.exists(r.remote)) stop(run, h, `새 파일 자리에 운영 파일이 생김: ${r.remote} — 새로 plan`)
    } else {
      const now = await ftp.shaOf(r.remote)
      if (!now) stop(run, h, `운영 파일 받기 실패: ${r.remote}`)
      if (now !== r.rsha) stop(run, h, `백업 이후 운영 파일이 바뀜: ${r.remote} — 새로 plan`)
    }
  }
}

/** 운영에 올린다: 다시 확인 → 고정본을 파일마다 임시 이름으로 올리고 이름 바꾸기 → 다시 받아 승인한 sha 와 대조. */
export async function upload(id: string, code: string, yes: boolean, h: StepHooks = {}): Promise<void> {
  await withLock(id, 'upload', h, async (run) => {
    const log = logger(run, h)
    assertUsable(run, h)
    checkCode(run, h, code, yes)
    if (run.has('rollback.done')) stop(run, h, '되돌린 run — 다시 올리려면 새로 plan')
    if (run.has('upload.done')) stop(run, h, '이미 올린 run — 다시 올리려면 새로 plan')
    if (run.uploadBegun()) stop(run, h, '부분 업로드된 run — 이어 올리지 않음. 되돌린 뒤 새로 plan')
    if (!run.has('backup.done')) stop(run, h, `백업 먼저(backup ${run.id})`)
    if (configChanged(run)) stop(run, h, '대상 설정이 plan 이후 바뀜 — 새로 plan')
    if (run.warnings().length && !run.warningsAcked())
      stop(run, h, `경고 ${run.warnings().length}건을 사람이 확인해야 올림 — 패널의 "확인함" (CLI: ack ${run.id})`)
    checkBackup(run, h)
    const rows = run.plan()
    const staged = stage(run, rows, h)
    const ftp = new Ftp(run.target, await resolveAuth(run.target), (s) => run.log(s))
    await recheck(run, ftp, h)
    log(`업로드 시작: ${run.target.label} ${rows.length}개 (코드 ${run.code()})`)
    run.write('upload.started', `${dateTime()}\n${Date.now()}\n`)
    let n = 0
    for (const [i, r] of rows.entries()) {
      if (!(await ftp.put(staged[i], r.remote))) stop(run, h, `업로드 실패: ${r.remote} (지금까지 ${n}개 → 되돌리기)`)
      if ((await ftp.shaOf(r.remote)) !== r.lsha) stop(run, h, `올린 뒤 대조 실패: ${r.remote} (지금까지 ${n}개 → 되돌리기)`)
      n++
      log(`[${n}/${rows.length}] ${r.remote}`)
      h.progress?.(n, rows.length)
    }
    run.write('upload.done', dateTime() + '\n')
    rmSync(run.path('stage'), { recursive: true, force: true })
    log(`업로드 완료 ${n}/${rows.length}`)
    if (rows.some((r) => r.local.endsWith('.class'))) log('다음: 사람이 톰캣 재기동')
  })
}

/** 운영 파일이 올린 파일(plan 의 로컬 sha)과 같은지 대조한다. */
export async function verify(id: string, h: StepHooks = {}): Promise<{ same: number; total: number }> {
  return withLock(id, 'verify', h, async (run) => {
    const log = logger(run, h)
    assertUsable(run, h)
    if (!run.has('upload.done')) stop(run, h, '업로드를 마친 run 만 대조한다')
    const ftp = new Ftp(run.target, await resolveAuth(run.target), (s) => run.log(s))
    const rows = run.plan()
    let same = 0
    for (const [i, r] of rows.entries()) {
      h.progress?.(i + 1, rows.length)
      const got = await ftp.shaOf(r.remote)
      if (!got) log(`받기 실패: ${r.remote}`)
      else if (got === r.lsha) same++
      else log(`다름: ${r.remote}`)
    }
    log(`verify: 운영 = 로컬 ${same}/${rows.length}`)
    if (same !== rows.length) {
      run.remove('verify.done')
      run.write('verify.failed', dateTime() + '\n')
      stop(run, h, 'verify 실패')
    }
    run.remove('verify.failed')
    run.write('verify.done', dateTime() + '\n')
    return { same, total: rows.length }
  })
}

/**
 * 이 run 보다 나중에 올린 run 중 같은 운영 파일을 건드린 것(되돌리지 않은 것). 그 run 의 변경이 말없이 사라지지
 * 않도록 되돌리기를 막는다. 순서는 run 이름이 아니라 실제 업로드 시각(Run.uploadAt)이고, run 은 모든 위치에서 전부
 * 본다. 어느 한쪽의 업로드 시각을 알 수 없으면(bash 부분 업로드) 순서를 모르므로 막는 쪽에 넣는다(unknown).
 */
export function laterOverlaps(run: Run): { run: string; files: string[]; unknown: boolean }[] {
  const mine = new Set(run.plan().map((r) => r.remote))
  const at = run.uploadAt()
  const out: { run: string; files: string[]; unknown: boolean }[] = []
  const here = destOf(run.target)
  for (const other of listRuns(run.target)) {
    if (other.id === run.id) continue
    // 같은 이름이라도 다른 서버(호스트·포트)의 run 은 같은 운영 파일이 아니다(경로는 운영 루트를 포함해 비교).
    const there = destOf(other.target)
    if (there.host !== here.host || there.port !== here.port) continue
    const s = other.status()
    if (s !== 'partial' && s !== 'uploaded' && s !== 'verified') continue
    const when = other.uploadAt()
    if (when === null) continue
    const unknown = when === 'unknown' || at === 'unknown'
    if (!unknown && at !== null && when < at) continue
    const files = other
      .plan()
      .map((r) => r.remote)
      .filter((x) => mine.has(x))
    if (files.length) out.push({ run: other.id, files, unknown })
  }
  return out
}

/**
 * 되돌리기 전에 운영이 이 run 이 남긴 그대로인지 본다: 덮어쓴 파일은 올린 것(lsha) 또는 아직 안 올린 원래 것(rsha),
 * 새 파일은 올린 것이거나 없음. 그 밖이면 누군가 그 뒤에 바꾼 것이라 되돌리지 않는다.
 */
async function checkRemoteBeforeRollback(run: Run, ftp: Ftp, h: StepHooks): Promise<void> {
  for (const r of run.plan()) {
    if (r.kind === 'M') {
      const now = await ftp.shaOf(r.remote)
      if (!now) stop(run, h, `운영 파일 받기 실패: ${r.remote}`)
      if (now !== r.lsha && now !== r.rsha) stop(run, h, `이 run 이 올린 뒤 운영 파일이 바뀜: ${r.remote} — 손으로 확인`)
    } else if (await ftp.exists(r.remote)) {
      if ((await ftp.shaOf(r.remote)) !== r.lsha) stop(run, h, `이 run 이 만든 파일이 그 뒤 바뀜: ${r.remote} — 손으로 확인`)
    }
  }
}

/** 덮어쓴 파일은 백업으로 되올리고, 새로 만든 파일은 지운다. */
export async function rollback(id: string, code: string, yes: boolean, h: StepHooks = {}): Promise<void> {
  await withLock(id, 'rollback', h, async (run) => {
    const log = logger(run, h)
    assertUsable(run, h)
    checkCode(run, h, code, yes)
    if (!run.has('backup.done')) stop(run, h, '백업 없음')
    if (run.has('rollback.done')) stop(run, h, '이미 되돌린 run')
    if (!run.uploadBegun()) stop(run, h, '올린 적 없는 run — 되돌릴 것이 없음')
    const later = laterOverlaps(run)
    const unsure = later.filter((x) => x.unknown)
    if (unsure.length)
      stop(run, h, `업로드 시각을 알 수 없는 run 이 같은 파일을 건드림 — 순서를 알 수 없어 되돌리지 않음(손으로 확인): ${unsure.map((x) => `${x.run}(${x.files.length}개)`).join(', ')}`)
    if (later.length)
      stop(run, h, `나중에 올린 run 이 같은 파일을 건드림 — 그 run 을 먼저 되돌리세요: ${later.map((x) => `${x.run}(${x.files.length}개)`).join(', ')}`)
    checkBackup(run, h)
    const ftp = new Ftp(run.target, await resolveAuth(run.target), (s) => run.log(s))
    await checkRemoteBeforeRollback(run, ftp, h)
    log(`되돌리기 시작: ${run.target.label} → ftp://${run.target.connection.host}${run.target.connection.root}`)
    let bad = 0
    const rows = run.plan()
    for (const [i, r] of rows.entries()) {
      h.progress?.(i + 1, rows.length)
      if (r.kind === 'M') {
        if (!(await ftp.put(run.backupPath(r.remote), r.remote))) {
          log(`복원 실패: ${r.remote}`)
          bad++
          continue
        }
        if ((await ftp.shaOf(r.remote)) !== r.rsha) {
          log(`복원 대조 실패: ${r.remote}`)
          bad++
        }
      } else {
        if (!(await ftp.exists(r.remote))) continue
        if (!(await ftp.delete(r.remote)) || (await ftp.exists(r.remote))) {
          log(`새 파일 삭제 실패: ${r.remote}`)
          bad++
        }
      }
    }
    if (bad) stop(run, h, `되돌리기 중 실패 ${bad}건(로그 ${run.path('deploy.log')})`)
    run.write('rollback.done', dateTime() + '\n')
    log('되돌리기 완료')
    if (rows.some((r) => r.local.endsWith('.class'))) log('다음: 사람이 톰캣 재기동')
  })
}
