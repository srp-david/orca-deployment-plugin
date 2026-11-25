// 백업 정리(ADR 0006): 90일 지난 run 의 backup/ 만 지우고 run 기록은 남긴다. 사람이 목록을 보고 확인할 때만 지운다.
// 빼는 run: 부분 업로드, 업로드 시각을 모르는 run, 어느 운영 파일이든 그 파일을 마지막으로 올린 run.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock, listRuns, openRun, STATUS_LABEL, type Run, type RunStatus } from './runs.ts'
import type { Target } from './target.ts'
import { dateTime } from './util.ts'

export const BACKUP_DAYS = 90
const DAY = 24 * 60 * 60 * 1000

/** 지우는 폴더: 백업과, 중간에 끊긴 백업이 남긴 임시 폴더. */
const DIRS = ['backup', 'backup.tmp']

export type PruneItem = { id: string; status: RunStatus; statusLabel: string; subject: string; at: number; bytes: number }
export type PrunePlan = {
  days: number
  items: PruneItem[]
  bytes: number
  /** 90일이 지났지만 어느 운영 파일을 마지막으로 올린 run 이라 남기는 것. */
  keptLatest: string[]
  /** 90일이 지났지만 다른 이유로 남기는 것과 그 이유(예: 업로드한 run 인데 plan.tsv 가 깨짐). */
  keptOther: KeptRun[]
}
export type KeptRun = { id: string; reason: string }

function sizeOf(path: string): number {
  if (!existsSync(path)) return 0
  const s = statSync(path)
  if (!s.isDirectory()) return s.size
  let n = 0
  for (const e of readdirSync(path)) n += sizeOf(join(path, e))
  return n
}

const hasBackup = (run: Run) => DIRS.some((d) => run.has(d))

/** `YYYY-MM-DD HH:MM:SS` 로 시작하면 그 시각, 아니면 null. */
function parseDateTime(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null
}

/**
 * 나이를 재는 시각. 올린 run 은 업로드를 시작한 시각, 올리지 않은 run 은 백업을 받은 시각(없으면 run 을 만든 시각).
 * 업로드 시각을 모르면 null — 정리에서 뺀다.
 */
function ageAt(run: Run): number | null {
  const up = run.uploadAt()
  if (up === 'unknown') return null
  if (up !== null) return up
  if (run.has('backup.done')) return parseDateTime(run.text('backup.done')) ?? statSync(run.path('backup.done')).mtimeMs
  return run.createdAt()
}

// 같은 대상이라도 run 을 만들 때의 서버(호스트·포트)가 다르면 다른 파일이다.
const destKey = (t: Target) => `${t.connection.host.toLowerCase()}:${t.connection.port ?? 21}`
const fileKey = (run: Run, remote: string) => `${destKey(run.target)}\t${remote}`

/**
 * 운영 파일마다, 모든 줄을 끝까지 올린 업로드(업로드됨·대조됨) 중 가장 나중 업로드 시각.
 * 부분 업로드는 "나중"으로 치지 않는다: 어느 줄이 실제로 올라갔는지 믿을 수 없고, 곧 되돌릴 상태라 되돌리면 앞 run 이
 * 다시 마지막이 된다. 업로드 시각을 모르는 run 도 치지 않는다. 둘 다 앞 run 이 마지막으로 남아 백업을 지우지 않는 쪽이다.
 */
function latestUploads(runs: Run[]): Map<string, number> {
  const latest = new Map<string, number>()
  for (const r of runs) {
    const s = r.status()
    if (s !== 'uploaded' && s !== 'verified') continue
    // plan.tsv 를 믿을 수 없으면 무엇을 올렸는지 모른다: 나중 업로드로 세지 않는다(앞 run 이 남는 쪽).
    if (r.planProblem()) continue
    const at = r.uploadAt()
    if (typeof at !== 'number') continue
    for (const row of r.plan()) {
      const k = fileKey(r, row.remote)
      if ((latest.get(k) ?? -Infinity) < at) latest.set(k, at)
    }
  }
  return latest
}

/**
 * 대상의 run 중 지금 백업을 지울 수 있는 것. 읽기만 한다.
 * "나중에 올림"은 이 대상의 run 만 본다(되돌리기의 나중 run 판정과 같은 범위). 다른 대상은 같은 호스트·포트·경로라도
 * FTP 계정마다 루트(chroot)가 달라 다른 파일일 수 있고, 이 대상의 잠금 밖에서 올리거나 되돌릴 수 있기 때문이다.
 */
export function prunePlan(t: Target, now = Date.now()): PrunePlan {
  const runs = listRuns(t)
  const latest = latestUploads(runs)
  const items: PruneItem[] = []
  const keptLatest: string[] = []
  const keptOther: KeptRun[] = []
  for (const run of runs) {
    if (run.backupPruned() || !hasBackup(run)) continue
    const status = run.status()
    if (status === 'partial') continue
    const at = ageAt(run)
    if (at === null || now - at < BACKUP_DAYS * DAY) continue
    const up = run.uploadAt()
    const broken = up !== null ? run.planProblem() : null
    if (broken) {
      // 업로드한 run 인데 무엇을 올렸는지 알 수 없다: 이 백업이 어느 파일의 유일한 이전본인지 판단할 수 없어 남긴다.
      keptOther.push({ id: run.id, reason: `업로드한 run 인데 ${broken} — 올린 파일을 알 수 없어 남김` })
      continue
    }
    if (status !== 'rolledBack' && typeof up === 'number') {
      // 그 파일을 이 run 보다 나중에 올린 run 이 없으면, 이 백업이 그 변경 전 운영본의 유일한 사본일 수 있다.
      if (run.plan().some((row) => (latest.get(fileKey(run, row.remote)) ?? up) <= up)) {
        keptLatest.push(run.id)
        continue
      }
    }
    const subject = /plan: (.*) \(기준 /.exec(run.text('deploy.log'))?.[1] ?? ''
    items.push({ id: run.id, status, statusLabel: STATUS_LABEL[status], subject, at, bytes: DIRS.reduce((n, d) => n + sizeOf(run.path(d)), 0) })
  }
  items.sort((a, b) => a.at - b.at)
  return { days: BACKUP_DAYS, items, bytes: items.reduce((n, x) => n + x.bytes, 0), keptLatest, keptOther }
}

/**
 * 백업을 지운다. ids 를 주면 그중 지금도 지울 수 있는 것만(사람이 본 목록보다 더 지우지 않게) 지운다.
 * 대상 잠금 안에서 다시 판단한다: 그 사이 업로드·되돌리기가 끼지 않게.
 */
export function pruneBackups(t: Target, ids: string[] | null, by = 'cli', now = Date.now()): { pruned: PruneItem[]; skipped: string[] } {
  const release = acquireLock({ target: t.id, run: '-', step: 'prune', by })
  try {
    const plan = prunePlan(t, now)
    const want = ids ? new Set(ids) : null
    const pruned = plan.items.filter((x) => !want || want.has(x.id))
    const skipped = ids ? ids.filter((id) => !pruned.some((x) => x.id === id)) : []
    for (const item of pruned) {
      const run = openRun(item.id)
      // 표시를 먼저 남긴다: 지우다 끊겨도 반쯤 남은 백업으로 되돌리거나 올리지 않게.
      run.write('backup.pruned', `${dateTime()}\n${item.bytes}\n`)
      for (const d of DIRS) rmSync(run.path(d), { recursive: true, force: true })
      run.log(`백업 정리: ${BACKUP_DAYS}일 지남 — 백업 파일을 지움(${item.bytes} 바이트, ${by}). 이 run 은 되돌릴 수 없음`)
    }
    return { pruned, skipped }
  } finally {
    release()
  }
}
