// run 을 사람이 볼 모양으로: 패널은 RunView 를, CLI 는 renderRun 의 글을 쓴다.
import { existsSync, readFileSync } from 'node:fs'
import { readLock, staleLock, STATUS_LABEL, type ListRow, type Run, type RunStatus } from './runs.ts'
import { configChanged } from './steps.ts'
import { toMsys } from './util.ts'
import type { PrInfo } from './plan.ts'

export type RunRowView = { kind: 'M' | 'A'; local: string; remote: string; note: string }
export type RunView = {
  id: string
  target: string
  label: string
  host: string
  root: string
  status: RunStatus
  statusLabel: string
  verifyFailed: boolean
  createdAt: number
  base: string
  tip: string
  head: string
  subject: string
  pr: PrInfo | null
  rows: RunRowView[]
  manual: ListRow[]
  skip: ListRow[]
  notes: ListRow[]
  errors: string[]
  /** 사람이 보고 판단할 경고. 보여 주기만 하고 막지 않는다. */
  warnings: string[]
  /** 막힌 run 은 null. */
  code: string | null
  hasClass: boolean
  uploaded: number
  total: number
  backupDir: string | null
  /** 지금 이 대상에서 다른 단계가 돌고 있으면 그 설명. */
  busy: string | null
  /** run 에 남은 대상 설정이 지금 설정과 다름: 백업·업로드는 막히고, 되돌리기는 이 run 의 주소(host/root)로 한다. */
  configChanged: boolean
  /** 끝난 작업이 남긴 잠금: 사람이 "잠금 풀기" 하기 전에는 백업·업로드·대조·되돌리기가 막힌다. */
  staleLock: string | null
  port: number
}

function staleOf(targetId: string): string | null {
  const s = staleLock(targetId)
  if (!s) return null
  return s.info ? `${s.info.step} ${s.info.run} (${s.info.by}, ${s.info.startedAt}부터)` : '내용 없는 잠금 파일'
}

export function viewRun(run: Run): RunView {
  const meta = run.meta()
  const status = run.status()
  const rows = run.plan()
  const repo = toMsys(run.target.repo) + '/'
  const subject = /plan: (.*) \(기준 /.exec(run.text('deploy.log'))?.[1] ?? ''
  const prFile = run.path('pr.json')
  const lock = readLock(run.target.id)
  return {
    id: run.id,
    target: run.target.id,
    label: run.target.label,
    host: run.target.connection.host,
    root: run.target.connection.root,
    status,
    statusLabel: STATUS_LABEL[status],
    verifyFailed: run.has('verify.failed'),
    createdAt: run.createdAt(),
    base: meta.BASE ?? '',
    tip: meta.TIP ?? '',
    head: meta.HEADC ?? '',
    subject,
    pr: existsSync(prFile) ? (JSON.parse(readFileSync(prFile, 'utf8')) as PrInfo) : null,
    rows: rows.map((r) => ({
      kind: r.kind,
      local: r.local.startsWith(repo) ? r.local.slice(repo.length) : r.local,
      remote: r.remote,
      note: r.note
    })),
    manual: run.list('manual.tsv'),
    skip: run.list('skip.tsv'),
    notes: run.list('notes.tsv'),
    errors: run.errors(),
    warnings: run.warnings(),
    code: status === 'blocked' ? null : run.code(),
    hasClass: rows.some((r) => r.local.endsWith('.class')),
    uploaded: status === 'uploaded' || status === 'verified' ? rows.length : run.uploadedCount(),
    total: rows.length,
    backupDir: run.has('backup.done') ? run.path('backup') : null,
    busy: lock ? `${lock.step} ${lock.run} (${lock.by}, ${lock.startedAt}부터)` : null,
    configChanged: configChanged(run),
    staleLock: staleOf(run.target.id),
    port: run.target.connection.port ?? 21
  }
}

export function logTail(run: Run, lines = 200): string[] {
  const all = run.text('deploy.log').split('\n').filter((l) => l !== '')
  return all.slice(-lines)
}

/** bash plan 출력과 같은 모양의 글. */
export function renderRun(v: RunView): string {
  const out: string[] = []
  out.push(`== 올릴 파일 (${v.rows.length}개) — 대상 ${v.label} ==`)
  for (const r of v.rows) out.push(`${r.kind === 'M' ? '덮어씀' : '새파일'}\t${r.local}\t→ ${r.remote}${r.note ? `  (${r.note})` : ''}`)
  if (v.manual.length) {
    out.push('', '== 손으로 처리 (올리지 않음) ==')
    for (const m of v.manual) out.push(`${m.path}  — ${m.reason}`)
  }
  if (v.notes.length) {
    out.push('', '== 참고 ==')
    for (const m of v.notes) out.push(`${m.path}  — ${m.reason}`)
  }
  if (v.skip.length) {
    out.push('', '== 매핑 밖 파일 ==')
    for (const m of v.skip) out.push(m.path)
  }
  if (v.hasClass) out.push('', '※ class 포함 — 올린 뒤 톰캣 재기동 필요')
  if (v.pr?.notes) out.push('', `== PR #${v.pr.number} 반영 시 주의 ==`, v.pr.notes)
  out.push('', `run: ${v.id}  (${v.statusLabel})`)
  if (v.errors.length) {
    out.push('== 문제 (해결 전에는 반영하지 않음) ==', ...v.errors)
  } else if (v.code) out.push(`확인 코드: ${v.code}`)
  if (v.warnings.length) {
    out.push(`== 경고 ${v.warnings.length}건 (올리기 전에 보세요. 막지는 않음) ==`, ...v.warnings)
  }
  return out.join('\n')
}
