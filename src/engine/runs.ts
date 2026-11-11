// run 기록. 폴더 형식은 bash deploy.sh 와 같다(meta.env, plan.tsv, targets.tsv, manual.tsv, skip.tsv,
// errors.txt, backup/, backup.done, upload.done, deploy.log). 새로 더한 것: target.json(그때 쓴 대상 설정),
// pr.json, notes.tsv, plan.done, upload.started, verify.done/verify.failed, rollback.done,
// backup.layout(v2 면 운영 파일은 backup/files/ 아래), stage/(업로드할 바이트 고정본), hidden(run 기록 화면에서 숨김),
// warnings.txt(사람이 보고 판단할 경고. 업로드를 막지 않는다).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { loadTargetOrDeleted, targetHistory, type Target } from './target.ts'
import { clock, expandHome, home, sha256, Stop, toNative } from './util.ts'

export type PlanRow = {
  kind: 'M' | 'A'
  /** plan.tsv 에 적힌 로컬 경로(bash 형식 /c/...). */
  local: string
  remote: string
  lsha: string
  rsha: string
  note: string
}
export type ListRow = { path: string; reason: string }

export type RunStatus = 'blocked' | 'planned' | 'backedUp' | 'partial' | 'uploaded' | 'verified' | 'rolledBack'

export const STATUS_LABEL: Record<RunStatus, string> = {
  blocked: '막힘',
  planned: 'plan됨',
  backedUp: '백업됨',
  partial: '부분 업로드',
  uploaded: '업로드됨',
  verified: '대조됨',
  rolledBack: '되돌림'
}

export function runsDir(t: Target): string {
  return toNative(expandHome(t.runs))
}

export class Run {
  readonly id: string
  readonly dir: string
  readonly target: Target

  constructor(id: string, dir: string, target: Target) {
    this.id = id
    this.dir = dir
    this.target = target
  }

  path(name: string): string {
    return join(this.dir, name)
  }
  has(name: string): boolean {
    return existsSync(this.path(name))
  }
  text(name: string): string {
    return this.has(name) ? readFileSync(this.path(name), 'utf8') : ''
  }
  write(name: string, data: string): void {
    writeFileSync(this.path(name), data, 'utf8')
  }
  append(name: string, data: string): void {
    appendFileSync(this.path(name), data, 'utf8')
  }
  remove(name: string): void {
    if (this.has(name)) unlinkSync(this.path(name))
  }
  /** `HH:MM:SS 내용` 을 deploy.log 에 남긴다. */
  log(line: string): void {
    this.append('deploy.log', `${clock()} ${line}\n`)
  }

  meta(): Record<string, string> {
    const m: Record<string, string> = {}
    for (const l of this.text('meta.env').split('\n')) {
      const i = l.indexOf('=')
      if (i > 0) m[l.slice(0, i)] = l.slice(i + 1).trim()
    }
    return m
  }

  plan(): PlanRow[] {
    return this.text('plan.tsv')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [kind, local, remote, lsha, rsha, note] = l.split('\t')
        return { kind: kind === 'M' ? 'M' : 'A', local, remote, lsha, rsha, note: note ?? '' }
      })
  }

  list(name: 'manual.tsv' | 'skip.tsv' | 'notes.tsv'): ListRow[] {
    return this.text(name)
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const i = l.indexOf('\t')
        return i < 0 ? { path: l, reason: '' } : { path: l.slice(0, i), reason: l.slice(i + 1) }
      })
  }

  /** plan 이 끝까지 돌았는가. 새 run 은 plan.done, bash 시절 run 은 로그의 "plan 완료" 줄로 안다. */
  planComplete(): boolean {
    return this.has('plan.done') || /plan 완료: /.test(this.text('deploy.log'))
  }

  /** run 을 막는 문제들. 끝나지 않은 plan 도 문제로 본다(중간에 끊긴 반영 목록을 쓰지 않도록). */
  errors(): string[] {
    const list = this.text('errors.txt')
      .split('\n')
      .filter((l) => l !== '')
    if (!this.planComplete()) list.push('plan 이 끝나지 않음(중단됐거나 아직 도는 중) — 새로 plan')
    return list
  }

  /** 사람이 보고 판단할 경고들. 보여 주기만 하고 run 을 막지 않는다(IntelliJ 처럼 판단은 사람이). */
  warnings(): string[] {
    return this.text('warnings.txt')
      .split('\n')
      .filter((l) => l !== '')
  }

  /** 확인 코드 = sha256(대상 + "\n" + plan.tsv) 앞 8자리 (bash 와 같다). */
  code(): string {
    return confirmCode(this.target.id, this.text('plan.tsv'))
  }

  /** 시각: run 이름의 YYYYMMDD-HHMMSS. */
  createdAt(): number {
    const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(this.id)
    if (!m) return statSync(this.dir).mtimeMs
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  }

  /**
   * 업로드 순서를 정하는 시각. 새 run 은 업로드를 시작한 순간(upload.started 의 ms), bash 시절 run 은 upload.done 에
   * 적힌 완료 날짜·시각(업로드는 대상 잠금 안에서 하나씩 돌므로 순서 비교에 충분하다). bash 부분 업로드처럼 날짜를
   * 알 수 없으면 'unknown', 올린 적 없으면 null.
   */
  uploadAt(): number | 'unknown' | null {
    if (this.has('upload.started')) {
      const v = Number(this.text('upload.started').split('\n')[1])
      return Number.isFinite(v) && v > 0 ? v : statSync(this.path('upload.started')).mtimeMs
    }
    if (this.has('upload.done')) {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(this.text('upload.done'))
      if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
      return 'unknown'
    }
    return /^\d{2}:\d{2}:\d{2} 업로드 시작/m.test(this.text('deploy.log')) ? 'unknown' : null
  }

  /** 업로드를 시작한 적이 있는가(끝났든 아니든). */
  uploadBegun(): boolean {
    return this.uploadAt() !== null
  }

  status(): RunStatus {
    const log = this.text('deploy.log')
    if (this.has('rollback.done') || (/되돌리기 완료/.test(log) && !this.has('upload.done'))) return 'rolledBack'
    if (this.errors().length > 0 || this.plan().length === 0) return 'blocked'
    if (this.has('verify.done')) return 'verified'
    if (this.has('upload.done')) return 'uploaded'
    if (this.uploadBegun()) return 'partial'
    if (this.has('backup.done')) return 'backedUp'
    return 'planned'
  }

  /** 부분 업로드일 때 올린 수: 로그의 마지막 [n/총] 줄. */
  uploadedCount(): number {
    let n = 0
    for (const m of this.text('deploy.log').matchAll(/\[(\d+)\/\d+\]/g)) n = Math.max(n, +m[1])
    return n
  }

  /**
   * 백업에서 운영 파일 하나의 자리. 새 백업은 backup/files/ 아래(메타데이터 new-files.txt 와 이름이 겹치지 않게)이고
   * 그 표시는 백업 폴더가 아니라 run 폴더의 backup.layout 에 둔다(운영 파일 이름과 겹치지 않게). bash 시절 백업은
   * backup/ 바로 아래.
   */
  backupPath(remote: string, base = 'backup'): string {
    const root = this.target.connection.root.replace(/\/+$/, '')
    const rel = remote.startsWith(root + '/') ? remote.slice(root.length + 1) : remote.replace(/^\/+/, '')
    const v2 = base !== 'backup' || this.text('backup.layout').trim() === 'v2' || !this.has('backup.done')
    return this.path(v2 ? `${base}/files/${rel}` : `${base}/${rel}`)
  }
}

export function confirmCode(targetId: string, planTsv: string): string {
  return sha256(`${targetId}\n${planTsv}`).slice(0, 8)
}

// ── run 찾기 ─────────────────────────────────────────────────
// run 을 만들 때 위치를 색인(~/.prod-deploy/run-index/<대상>.tsv)에 남긴다. run 기록 폴더 설정을 바꾸거나 대상을
// 지웠다가 같은 이름으로 다시 만들어도, 이미 올린 run 을 찾아 되돌릴 수 있게.

function indexFile(targetId: string): string {
  return join(home(), 'run-index', `${targetId}.tsv`)
}

function indexed(targetId: string): Map<string, string> {
  const m = new Map<string, string>()
  const f = indexFile(targetId)
  if (!existsSync(f)) return m
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    const i = l.indexOf('\t')
    if (i > 0) m.set(l.slice(0, i), l.slice(i + 1))
  }
  return m
}

/** 이 대상의 run 이 있을 수 있는 폴더들: 지금 설정, 색인, 지운 설정들. */
function runDirsOf(targetId: string): string[] {
  const dirs: string[] = []
  const add = (d: string) => {
    const n = toNative(d).replace(/\\/g, '/').replace(/\/+$/, '')
    if (!dirs.some((x) => x.toLowerCase() === n.toLowerCase())) dirs.push(n)
  }
  for (const t of targetHistory(targetId)) add(runsDir(t))
  for (const dir of indexed(targetId).values()) add(dirname(dir))
  return dirs
}

function findRunDir(id: string, targetId: string): string | null {
  const hit = indexed(targetId).get(id)
  if (hit && existsSync(join(hit, 'meta.env'))) return hit
  for (const d of runDirsOf(targetId)) if (existsSync(join(d, id, 'meta.env'))) return join(d, id)
  return null
}

/**
 * run 이름 `<대상>-<YYYYMMDD-HHMMSS>-<sha8>` → Run. 대상 설정은 run 에 남긴 사본을 먼저 쓴다(없으면 지금 설정 —
 * bash 시절 run. 쓰기 전에 steps.ts 가 그 run 의 기록과 지금 설정이 같은지 확인한다).
 */
export function openRun(id: string): Run {
  if (!/^[a-z0-9_]+-\d{8}-\d{6}-[0-9a-f]{8}$/.test(id)) throw new Stop(`run 이름이 잘못됨: ${id}`)
  const targetId = id.slice(0, id.indexOf('-'))
  const dir = findRunDir(id, targetId)
  if (!dir) throw new Stop(`run 없음: ${id} (찾아본 곳: ${runDirsOf(targetId).join(', ') || '없음'})`)
  const snap = join(dir, 'target.json')
  const target = existsSync(snap) ? (JSON.parse(readFileSync(snap, 'utf8')) as Target) : loadTargetOrDeleted(targetId)
  const run = new Run(id, dir, target)
  const meta = run.meta()
  if (meta.RUN_TARGET !== targetId) throw new Stop(`run 의 대상(${meta.RUN_TARGET})과 이름의 대상(${targetId})이 다름`)
  return run
}

export function newRun(t: Target, id: string): Run {
  const dir = join(runsDir(t), id)
  if (existsSync(dir) || findRunDir(id, t.id)) throw new Stop(`같은 이름의 run 이 이미 있음: ${id}`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(dirname(indexFile(t.id)), { recursive: true })
  appendFileSync(indexFile(t.id), `${id}\t${dir.replace(/\\/g, '/')}\n`, 'utf8')
  return new Run(id, dir, t)
}

/** run 기록 화면에서 숨겼는가. 표시만의 문제다 — 안전 검사(나중 run, 되돌리기)는 숨긴 run 도 본다. */
export function isHidden(run: Run): boolean {
  return existsSync(run.path('hidden'))
}

/** run 기록 화면에서 숨기기/다시 보이기. 부분 업로드 run 은 숨기지 않는다(되돌려야 할 상태를 가리지 않게). */
export function setHidden(run: Run, hidden: boolean): boolean {
  if (hidden && run.status() === 'partial') return false
  if (hidden) writeFileSync(run.path('hidden'), `${new Date().toISOString()}\n`)
  else if (existsSync(run.path('hidden'))) unlinkSync(run.path('hidden'))
  return true
}

/** 대상의 run 들(모든 위치), 최근 것부터. limit 은 화면용이다 — 안전 검사는 limit 없이 부른다. */
export function listRuns(t: Target, limit = Infinity): Run[] {
  const ids = new Set<string>()
  for (const d of runDirsOf(t.id)) {
    if (!existsSync(d)) continue
    for (const n of readdirSync(d)) if (n.startsWith(`${t.id}-`) && existsSync(join(d, n, 'meta.env'))) ids.add(n)
  }
  const out: Run[] = []
  for (const id of [...ids].sort().reverse()) {
    if (out.length >= limit) break
    try {
      out.push(openRun(id))
    } catch {
      // 깨진 run 은 목록에서 뺀다
    }
  }
  return out
}

// ── 대상마다 잠금 ─────────────────────────────────────────────
// 만들기는 'wx'(이미 있으면 실패) 한 번으로 겨룬다. 죽은 프로세스가 남긴 잠금은 자동으로 치우지 않는다: 여러 작업이
// 동시에 치우려 들면 살아 있는 잠금을 지울 수 있기 때문이다. 사람이 `unlock`(또는 패널의 "잠금 풀기")으로 치운다.

export type LockInfo = { target: string; run: string; step: string; pid: number; startedAt: string; by: string; token: string }

function lockFile(targetId: string): string {
  return join(home(), 'locks', `${targetId}.lock`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM'
  }
}

function parseLock(f: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as LockInfo
  } catch {
    return null
  }
}

/** 살아 있는 잠금. 없거나 죽은 프로세스의 것이면 null. */
export function readLock(targetId: string): LockInfo | null {
  const info = parseLock(lockFile(targetId))
  return info && alive(info.pid) ? info : null
}

export type StaleLock = { info: LockInfo | null; ageMs: number }

/** 죽은 프로세스가 남긴(또는 내용 없이 오래된) 잠금. 없거나 살아 있으면 null. */
export function staleLock(targetId: string): StaleLock | null {
  const f = lockFile(targetId)
  if (!existsSync(f)) return null
  let ageMs = 0
  try {
    ageMs = Date.now() - statSync(f).mtimeMs
  } catch {
    return null
  }
  const info = parseLock(f)
  if (info) return alive(info.pid) ? null : { info, ageMs }
  return ageMs > 10000 ? { info: null, ageMs } : null
}

const describe = (h: LockInfo) => `${h.step} ${h.run} (${h.by}, ${h.startedAt}부터)`

/** 백업·업로드·대조·되돌리기 동안 대상을 잠근다. 이미 있으면(죽은 잠금이어도) 누가 언제부터인지 알리고 멈춘다. */
export function acquireLock(info: Omit<LockInfo, 'pid' | 'startedAt' | 'token'>): () => void {
  const f = lockFile(info.target)
  mkdirSync(join(home(), 'locks'), { recursive: true })
  const mine: LockInfo = {
    ...info,
    pid: process.pid,
    startedAt: new Date().toLocaleString('sv-SE'),
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
  try {
    writeFileSync(f, JSON.stringify(mine), { flag: 'wx' })
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') throw e
    const other = parseLock(f)
    if (other && alive(other.pid)) throw new Stop(`${info.target} 에서 다른 작업 중: ${describe(other)}`)
    if (!other && !staleLock(info.target)) throw new Stop(`${info.target} 잠금을 확인하는 중 — 잠시 뒤 다시`)
    throw new Stop(
      `${info.target} 에 끝난 작업의 잠금이 남아 있음${other ? `: ${describe(other)}` : ''} — 그 작업이 정말 끝났는지 본 뒤 ` +
        `"잠금 풀기"(CLI: unlock ${info.target})`
    )
  }
  return () => {
    if (parseLock(f)?.token === mine.token) {
      try {
        unlinkSync(f)
      } catch {
        // 이미 없음
      }
    }
  }
}

/**
 * 사람이 고른 "잠금 풀기": 죽은 작업의 잠금만 지운다. 살아 있으면 멈춘다.
 * 잠금 풀기끼리는 `<대상>.unlock` 을 'wx' 로 잡아 한 번에 하나만 돈다. 그 안에서 확인한 죽은 잠금은 지울 때까지
 * 그대로다: 잠금 파일을 지우는 쪽은 주인(죽음)과 잠금 풀기(지금 하나뿐)뿐이고, 새 잠금은 파일이 없을 때만 생긴다.
 */
export function clearStaleLock(targetId: string): string {
  const guard = `${lockFile(targetId)}.unlock`
  mkdirSync(join(home(), 'locks'), { recursive: true })
  try {
    writeFileSync(guard, String(process.pid), { flag: 'wx' })
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') throw e
    throw new Stop(`${targetId} 잠금 풀기가 이미 도는 중 — 끝난 뒤 다시(오래 남아 있으면 ${guard} 를 확인)`)
  }
  try {
    const s = staleLock(targetId)
    if (!s) {
      const live = readLock(targetId)
      if (live) throw new Stop(`${targetId} 의 잠금은 아직 살아 있는 작업의 것: ${describe(live)}`)
      return '풀 잠금이 없음'
    }
    unlinkSync(lockFile(targetId))
    return s.info ? `풀었음: ${describe(s.info)}` : '풀었음: 내용 없는 잠금'
  } finally {
    try {
      unlinkSync(guard)
    } catch {
      // 무시
    }
  }
}
