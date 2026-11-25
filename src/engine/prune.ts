// 백업 정리(ADR 0006): 90일 지난 run 의 backup/ 만 지우고 run 기록은 남긴다. 사람이 목록을 보고 확인할 때만 지운다.
// 빼는 run: 부분 업로드, 업로드 시각을 모르는 run, 어느 운영 파일이든 그 파일을 마지막으로 올린 run.
import { lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock, listRuns, openRun, runDirProblem, STATUS_LABEL, type Run, type RunStatus } from './runs.ts'
import type { Target } from './target.ts'
import { dateTime, sha256, Stop } from './util.ts'

export const BACKUP_DAYS = 90
const DAY = 24 * 60 * 60 * 1000

/** 지우는 폴더: 백업과, 중간에 끊긴 백업이 남긴 임시 폴더. */
const DIRS = ['backup', 'backup.tmp']

export type PruneItem = {
  id: string
  status: RunStatus
  statusLabel: string
  subject: string
  at: number
  bytes: number
  /** 지난 백업 정리가 지우다 멈춘 run: 남은 백업을 마저 지운다. */
  retry: boolean
}
export type PrunePlan = {
  days: number
  items: PruneItem[]
  bytes: number
  /** 90일이 지났지만 어느 운영 파일을 마지막으로 올린 run 이라 남기는 것. */
  keptLatest: string[]
  /** 90일이 지났지만 다른 이유로 남기는 것과 그 이유(예: 업로드한 run 인데 plan.tsv 가 깨짐). */
  keptOther: KeptRun[]
  /** 이 목록의 확인 코드(pruneCode). CLI 는 이 코드를 받아야 지운다. */
  code: string
}
export type KeptRun = { id: string; reason: string }
/** 지우다 실패한 run 과 그 오류(경로 포함). */
export type PruneFailure = { id: string; error: string }
export type PruneResult = { pruned: PruneItem[]; skipped: string[]; failed: PruneFailure[] }

/** 크기 합. 링크·정션은 따라가지 않는다(바깥 트리나 순환 링크를 세지 않게). */
function sizeOf(path: string): number {
  let s
  try {
    s = lstatSync(path)
  } catch {
    return 0
  }
  if (s.isSymbolicLink()) return 0
  if (!s.isDirectory()) return s.size
  let n = 0
  for (const e of readdirSync(path)) n += sizeOf(join(path, e))
  return n
}

/**
 * 지워도 되는 자리인가: run 폴더가 이 대상의 run 기록 폴더 안의 진짜 폴더이고, 지울 폴더(backup, backup.tmp)도 링크·정션이
 * 아니며 실경로가 그 run 폴더 안. 아니면 그 이유. 링크를 따라 run 기록 폴더 밖을 지우지 않게.
 */
function deleteProblem(run: Run): string | null {
  const bad = runDirProblem(run)
  if (bad) return bad
  try {
    const home = realpathSync.native(run.dir)
    for (const d of DIRS) {
      const p = run.path(d)
      let s
      try {
        s = lstatSync(p)
      } catch {
        continue // 없음
      }
      if (s.isSymbolicLink()) return `${d} 가 링크(정션)임: ${p}`
      if (realpathSync.native(p).toLowerCase() !== join(home, d).toLowerCase()) return `${d} 의 실경로가 run 폴더 밖(링크·정션을 따라감): ${p}`
    }
    return null
  } catch (e) {
    return `백업 폴더를 확인하지 못함: ${(e as Error).message}`
  }
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

/** 백업 정리의 확인 코드 = sha256(대상 이름 + "\n" + 지울 run 이름을 정렬해 "\n" 으로 이은 것) 앞 8자리. */
export function pruneCode(targetId: string, ids: string[]): string {
  return sha256(`${targetId}\n${[...ids].sort().join('\n')}`).slice(0, 8)
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
    // 저장 위치를 믿을 수 없는 run(링크·정션 너머)의 기록도 근거로 쓰지 않는다: 다른 백업의 보존 여부를 바꾸지 않게.
    if (runDirProblem(r)) continue
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
  const itemOf = (run: Run, status: RunStatus, at: number, retry: boolean): PruneItem => ({
    id: run.id,
    status,
    statusLabel: STATUS_LABEL[status],
    subject: /plan: (.*) \(기준 /.exec(run.text('deploy.log'))?.[1] ?? '',
    at,
    bytes: DIRS.reduce((n, d) => n + sizeOf(run.path(d)), 0),
    retry
  })
  for (const run of runs) {
    // 지난 정리가 지우다 멈춘 run 도 지금의 보존 규칙을 모두 거친다: 그 사이 나중 run 을 되돌렸으면 다시 마지막 run 일 수 있다.
    // 규칙에 걸리면 지우지 않고 이유를 보인다. "지우는 중" 표시는 그대로 두어 되돌리기·업로드는 계속 막는다
    // (남은 백업이 온전한지 알 수 없으므로).
    const unfinished = run.pruneUnfinished()
    if (!unfinished && (run.backupPruned() || !hasBackup(run))) continue
    const keepUnfinished = (why: string) =>
      keptOther.push({ id: run.id, reason: `지우다 멈춘 run — ${why}, 백업이 일부 지워졌을 수 있음` })
    const status = run.status()
    const at = ageAt(run)
    const old = at !== null && now - at >= BACKUP_DAYS * DAY
    const up = run.uploadAt()
    // 업로드 흔적이 있는데 plan.tsv 를 믿을 수 없으면 무엇을 올렸는지 모른다: 이 백업이 어느 파일의 유일한 이전본인지 판단할
    // 수 없어 남긴다. 부분 업로드·시각 불명으로 빠지기 전에 보아 이유를 보인다(90일 안 된 것은 원래 남으니 뺀다).
    const broken = up !== null && (at === null || old) ? run.planProblem() : null
    if (broken) {
      const why = `업로드한 run 인데 ${broken} — 올린 파일을 알 수 없어 남김`
      if (unfinished) keepUnfinished(why)
      else keptOther.push({ id: run.id, reason: why })
      continue
    }
    if (status === 'partial') {
      if (unfinished) keepUnfinished('부분 업로드 run 이라 남김')
      continue
    }
    if (at === null || !old) {
      if (unfinished) keepUnfinished(at === null ? '업로드 시각을 몰라 남김' : `${BACKUP_DAYS}일이 지나지 않아 남김`)
      continue
    }
    // 저장 위치를 본다: 링크·정션 너머의 run 은 그 기록도 믿지 않고, 지우지 않는다.
    const unsafe = deleteProblem(run)
    if (unsafe) {
      keptOther.push({ id: run.id, reason: `${unsafe} — 링크를 따라 지우지 않으려고 남김` })
      continue
    }
    if (status !== 'rolledBack' && typeof up === 'number') {
      // 그 파일을 이 run 보다 나중에 올린 run 이 없으면, 이 백업이 그 변경 전 운영본의 유일한 사본일 수 있다.
      if (run.plan().some((row) => (latest.get(fileKey(run, row.remote)) ?? up) <= up)) {
        if (unfinished) keepUnfinished('지금 어느 운영 파일을 마지막으로 올린 run 이라 남김')
        else keptLatest.push(run.id)
        continue
      }
    }
    items.push(itemOf(run, status, at, unfinished))
  }
  items.sort((a, b) => a.at - b.at)
  const code = pruneCode(t.id, items.map((x) => x.id))
  return { days: BACKUP_DAYS, items, bytes: items.reduce((n, x) => n + x.bytes, 0), keptLatest, keptOther, code }
}

/**
 * 백업을 지운다. 사람이 본 목록보다 더 지우지 않게, 무엇을 지울지는 둘 중 하나로만 받는다:
 * - run 이름들(패널): 그중 지금도 지울 수 있는 것만 지운다.
 * - 확인 코드(CLI): 지금 지울 목록의 코드와 같을 때만 그 목록 전부를 지운다. 다르면 아무것도 지우지 않고 멈춘다.
 * 대상 잠금 안에서 다시 판단한다: 그 사이 업로드·되돌리기가 끼지 않게.
 * 한 run 을 지우다 실패해도 나머지 run 은 계속 지우고, 실패는 결과의 failed 와 그 run 의 로그에 남긴다.
 * remove 는 폴더 하나를 지우는 함수다(시험에서 삭제 실패를 만들 때만 바꾼다).
 */
export function pruneBackups(
  t: Target,
  pick: string[] | { code: string },
  by = 'cli',
  now = Date.now(),
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })
): PruneResult {
  const release = acquireLock({ target: t.id, run: '-', step: 'prune', by })
  try {
    const plan = prunePlan(t, now)
    let chosen: PruneItem[]
    const skipped: string[] = []
    if (Array.isArray(pick)) {
      const want = new Set(pick)
      chosen = plan.items.filter((x) => want.has(x.id))
      skipped.push(...pick.filter((id) => !chosen.some((x) => x.id === id)))
    } else {
      // 지금 코드를 알려 주지 않는다: 목록을 다시 보고 그 코드를 쓰게.
      if (pick.code !== plan.code)
        throw new Stop(`확인 코드가 지금 지울 목록과 다름(그 사이 지울 run 이 바뀌었을 수 있음) — 아무것도 지우지 않음. 다시 목록을 보세요(prune --target ${t.id})`)
      chosen = plan.items
    }
    const pruned: PruneItem[] = []
    const failed: PruneFailure[] = []
    for (const item of chosen) {
      let run: Run | null = null
      try {
        run = openRun(item.id)
        // 지우기 바로 전에 자리를 다시 본다: 판단한 뒤 링크로 바뀌었으면 지우지 않는다.
        if (deleteProblem(run)) {
          skipped.push(item.id)
          continue
        }
        // "지우는 중" 표시를 먼저 남긴다: 지우다 끊겨도 반쯤 남은 백업으로 되돌리거나 올리지 않게(백업 지움처럼 막는다).
        // 다 지운 뒤에 "지움" 표시로 바꾼다. 지우는 중으로 남은 run 은 다음 정리가 보존 규칙을 다시 거쳐 지울 수 있으면 마저 지운다.
        if (!run.pruneUnfinished()) run.write('backup.pruning', `${dateTime()}\n${item.bytes}\n`)
        for (const d of DIRS) remove(run.path(d))
        run.write('backup.pruned', `${dateTime()}\n${item.bytes}\n`)
        try {
          run.remove('backup.pruning')
        } catch {
          // 지움 표시를 이미 썼으니 지우기는 끝났다: 남은 지우는 중 표시는 무시한다(Run.pruneUnfinished 가 지움 표시를 먼저 본다)
        }
        run.log(`백업 정리: ${BACKUP_DAYS}일 지남 — ${item.retry ? '지우다 멈춘 ' : ''}백업 파일을 지움(${item.bytes} 바이트, ${by}). 이 run 은 되돌릴 수 없음`)
        pruned.push(item)
      } catch (e) {
        const error = (e as Error).message
        failed.push({ id: item.id, error })
        try {
          run?.log(`백업 정리 중 실패(일부 남음): ${error} — 이 run 은 되돌릴 수 없음. 다음 백업 정리에서 다시 판단해 지울 수 있으면 남은 백업을 마저 지움`)
        } catch {
          // 로그도 못 쓰면 결과의 failed 로만 알린다
        }
      }
    }
    return { pruned, skipped, failed }
  } finally {
    release()
  }
}
