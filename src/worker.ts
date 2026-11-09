// 플러그인 워커. 짧은 일(대상 설정, 준비 확인, run 목록)은 엔진을 직접 부르고, 운영 FTP 단계
// (plan·backup·upload·verify·rollback)는 같은 엔진의 CLI 를 떨어진 프로세스로 띄운다(ADR 0002):
// 워커가 정리되거나 다시 시작돼도 업로드는 끝까지 가고, 진행은 작업 기록 파일로 이어 본다.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { credentialUser, deleteCredential, writeCredential } from './engine/creds.ts'
import { mergedPrs } from './engine/git.ts'
import { jobsDir, listJobs, newJobId, readJob, writeJob, type Job, type JobStep } from './engine/jobs.ts'
import { preflight } from './engine/plan.ts'
import { ackWarnings, clearStaleLock, isHidden, listRuns, openRun, setHidden } from './engine/runs.ts'
import {
  deleteTarget,
  detectTarget,
  listTargets,
  loadTarget,
  mainBranch,
  netrcPath,
  saveTarget,
  validateTarget,
  type Target
} from './engine/target.ts'
import { Stop, toNative } from './engine/util.ts'
import { logTail, viewRun } from './engine/view.ts'
import { configVerdict } from './config-verdict.ts'
import { openPanel } from './open-panel.ts'
import type { RecentPr, RunSummary, TargetSummary, Workspace } from './protocol.ts'

// Orca 는 워커에 정해진 환경변수만 넘긴다. gh·git 이 설정을 찾도록 빠진 것을 채운다.
const profile = process.env.USERPROFILE ?? ''
process.env.APPDATA ??= join(profile, 'AppData', 'Roaming')
process.env.LOCALAPPDATA ??= join(profile, 'AppData', 'Local')

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

const LABEL: Record<JobStep, string> = {
  check: '준비 확인',
  plan: '반영 목록 만들기',
  backup: '백업',
  upload: '업로드',
  verify: '대조',
  rollback: '되돌리기'
}

/** 패널에 보여 줄 수 있는 오류로: 엔진의 멈춤 이유는 그대로, 나머지는 action_failed. */
function fail(e: unknown, code = 'action_failed'): never {
  const err = new Error(e instanceof Error ? e.message : String(e)) as Error & { code: string }
  err.code = e instanceof Stop ? 'invalid_params' : code
  throw err
}

/** 모든 패널 요청의 응답 출구. Orca 는 JSON 이 아닌 값(undefined 칸 등)이 섞인 응답을 거절하므로
 *  JSON 으로 한 번 바꿔 보낸다(undefined 칸은 빠진다). */
async function guard<T>(body: () => Promise<T> | T): Promise<T> {
  try {
    const out = await body()
    return out === undefined ? out : (JSON.parse(JSON.stringify(out)) as T)
  } catch (e) {
    fail(e)
  }
}

function summary(t: Target): TargetSummary {
  return {
    id: t.id,
    label: t.label,
    host: t.connection.host,
    port: t.connection.port ?? 21,
    root: t.connection.root,
    repo: t.repo,
    test: !!t.test
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  // 상태 표시줄 항목·명령 팔레트: 패널이 보이면 오른쪽 사이드바를 닫고, 아니면 패널을 연다.
  let panelSeen = { visible: false, at: 0 }
  orca.panels.handle('status.reset', () =>
    guard(async () => {
      const busy = listJobs().some((j) => j.state === 'running' || j.state === 'starting')
      if (!busy) await status(null)
      return { ok: true as const }
    })
  )

  orca.panels.handle('panel.visible', ({ visible }) => {
    panelSeen = { visible, at: Date.now() }
    return { ok: true as const }
  })
  orca.commands.register('openPanel', async () => {
    if (panelSeen.visible && Date.now() - panelSeen.at < 3000) {
      try {
        await orca.host.call('commands.run', { action: 'sidebar.right.toggle' })
        panelSeen = { visible: false, at: Date.now() }
        return undefined
      } catch (e) {
        orca.log(`사이드바 닫기 실패: ${(e as Error).message}`)
        return `사이드바를 닫지 못함: ${(e as Error).message}`
      }
    }
    const why = await openPanel()
    if (why) orca.log(`패널 열기 실패: ${why}`)
    return why ?? undefined
  })
  const watched = new Map<string, string>()
  /** 이 워커가 띄운 CLI 의 프로세스 번호(작업 id → pid). */
  const spawned = new Map<string, number>()
  /** "설정 확인"으로 띄운 plan 작업 id. 끝나면 설정 판정으로 알린다. */
  const configChecks = new Set<string>()
  const running = (pid: number | undefined) => {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as { code?: string }).code === 'EPERM'
    }
  }
  let timer: ReturnType<typeof setInterval> | null = null

  /** 작업 이름. "설정 확인"으로 띄운 plan 은 설정 확인이라 부른다. */
  const labelOf = (job: Job) => (configChecks.has(job.id) ? '설정 확인' : LABEL[job.step])

  /** 끝난 작업을 사람에게 알릴 말. 설정 확인은 plan 이 "문제"(이미 반영됨)로 끝나는 것이 정상이라 따로 판정한다. */
  function ending(job: Job): { text: string; ok: boolean; body: string | null } {
    if (configChecks.has(job.id)) {
      if (!job.run) return { text: `${job.target} 설정 확인 실패`, ok: false, body: job.message }
      try {
        const v = configVerdict(viewRun(openRun(job.run)))
        return { text: `${job.target} ${v.ok ? '설정 맞음' : '설정 확인 필요'}`, ok: v.ok, body: v.lines.join('\n') }
      } catch (e) {
        return { text: `${job.target} 설정 확인 실패`, ok: false, body: (e as Error).message }
      }
    }
    const ok = job.state === 'done'
    return { text: `${job.target} ${LABEL[job.step]} ${ok ? '끝' : '실패'}`, ok, body: job.message }
  }

  async function status(job: Job | null): Promise<void> {
    try {
      if (!job || job.state === 'done' || job.state === 'failed') {
        const end = job ? ending(job) : null
        await orca.host.call('statusBar.update', {
          id: 'deploy',
          text: end?.text ?? '운영 반영',
          icon: end && !end.ok ? 'warning' : 'rocket',
          tone: end && !end.ok ? 'danger' : 'neutral'
        })
        return
      }
      const p = job.progress ? ` ${job.progress.n}/${job.progress.total}` : ''
      await orca.host.call('statusBar.update', {
        id: 'deploy',
        text: `${job.target} ${labelOf(job)}${p}`,
        icon: 'upload',
        tone: job.step === 'upload' || job.step === 'rollback' ? 'warning' : 'accent'
      })
    } catch {
      // 상태 표시줄이 없는 환경
    }
  }

  /** 띄운 작업들의 기록 파일을 읽어 바뀐 것만 패널에 알린다. 다 끝나면 멈춘다. */
  function poll(): void {
    for (const id of [...watched.keys()]) {
      const job = readJob(id)
      if (!job) {
        // 쓰는 순간과 겹쳐 못 읽었을 수 있다: 파일이 정말 없을 때만 지켜보기를 멈춘다.
        if (!existsSync(join(jobsDir(), `${id}.json`))) watched.delete(id)
        continue
      }
      // 파일만 보고 끝남으로 추정했는데 띄운 프로세스가 살아 있으면 아직 도는 중이다.
      if (job.inferred && running(spawned.get(id))) continue
      const sig = `${job.state}|${job.progress?.n ?? ''}|${job.lines.length}|${job.run ?? ''}|${job.message ?? ''}`
      if (watched.get(id) !== sig) {
        watched.set(id, sig)
        orca.panels.post('job.changed', job)
        void status(job)
        if (job.state === 'done' || job.state === 'failed') {
          watched.delete(id)
          spawned.delete(id)
          const end = ending(job)
          configChecks.delete(id)
          void orca.host
            .call('notifications.show', {
              title: `운영 반영: ${end.text}`,
              ...(end.body ? { body: end.body } : {})
            })
            .catch(() => {})
        }
      }
    }
    if (watched.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function watch(id: string): void {
    watched.set(id, '')
    if (!timer) timer = setInterval(poll, 700)
  }

  // 워커가 다시 시작됐을 때 아직 도는 작업을 이어 본다.
  for (const j of listJobs()) if (j.state === 'running' || j.state === 'starting') watch(j.id)
  void status(null)

  orca.panels.handle('targets.list', () => guard(() => listTargets().map(summary)))

  orca.panels.handle('target.get', ({ id }) =>
    guard(async () => {
      const target = loadTarget(id)
      const netrc = netrcPath(target)
      return { target, credUser: await credentialUser(id), netrc: !!netrc && existsSync(toNative(netrc)) }
    })
  )

  orca.panels.handle('target.validate', ({ target }) => guard(() => ({ errors: validateTarget(target) })))

  orca.panels.handle('target.save', ({ target, previousId }) =>
    guard(() => {
      const errors = validateTarget(target)
      if (errors.length) return { errors }
      // run 이름과 기록 위치가 대상 이름에 묶여 있어, 이름을 바꾸면 이미 올린 run 을 되돌릴 길이 끊긴다.
      if (previousId && previousId !== target.id)
        return { errors: ['대상 이름은 바꿀 수 없음 — 새 대상으로 만들고 이 대상을 지우세요'] }
      if (!previousId && listTargets().some((t) => t.id === target.id))
        return { errors: [`같은 이름의 대상이 이미 있음: ${target.id}`] }
      saveTarget(target)
      return { errors: [] }
    })
  )

  orca.panels.handle('target.delete', ({ id }) =>
    guard(() => {
      deleteTarget(id)
      return null
    })
  )

  orca.panels.handle('creds.set', ({ id, user, password }) =>
    guard(async () => {
      loadTarget(id)
      await writeCredential(id, { user: user.trim(), password })
      return { user: user.trim() }
    })
  )

  orca.panels.handle('creds.delete', ({ id }) =>
    guard(async () => {
      await deleteCredential(id)
      return null
    })
  )

  orca.panels.handle('workspace.detect', () =>
    guard(async (): Promise<Workspace> => {
      const ctx = await orca.host.call('workspace.readContext').catch(() => null)
      if (!ctx) return { target: null, candidates: [], known: false, name: null, path: null }
      const list = await orca.host.call('workspace.list').catch(() => null)
      // API 에 공통 id 가 없어 이름·브랜치가 정확히 하나와 맞을 때만 그 경로를 쓴다.
      const hits = (list?.workspaces ?? []).filter(
        (w) => !w.hostId && w.name === ctx.displayName && (w.branch ?? '') === (ctx.branch ?? '')
      )
      if (hits.length !== 1) return { target: null, candidates: [], known: false, name: ctx.displayName, path: null }
      const d = await detectTarget(hits[0].path)
      return { target: d.target, candidates: d.candidates, known: d.repoKnown, name: ctx.displayName, path: hits[0].path }
    })
  )

  orca.panels.handle('check', ({ target, spec }) =>
    guard(async () => {
      const pf = await preflight(loadTarget(target), spec)
      return {
        ok: pf.ok,
        items: pf.items,
        subject: pf.resolved?.subject ?? null,
        tip: pf.resolved?.tip ?? null,
        pr: pf.resolved?.pr ?? null
      }
    })
  )

  orca.panels.handle('prs.recent', ({ target }) =>
    guard(async (): Promise<RecentPr[]> => {
      const t = loadTarget(target)
      const prs = await mergedPrs(t.repo, mainBranch(t))
      // 이 대상에서 PR 별로 가장 앞선 run 상태
      const rank = { deployed: 3, partial: 2, planned: 1 } as const
      const best = new Map<number, keyof typeof rank>()
      for (const r of listRuns(t)) {
        const v = viewRun(r)
        if (!v.pr) continue
        const s = v.status === 'uploaded' || v.status === 'verified' ? 'deployed' : v.status === 'partial' ? 'partial' : v.status === 'planned' || v.status === 'backedUp' ? 'planned' : null
        const cur = best.get(v.pr.number)
        if (s && (!cur || rank[s] > rank[cur])) best.set(v.pr.number, s)
      }
      return prs.map((p) => ({ number: p.number, title: p.title, mergedAt: p.mergedAt, deploy: best.get(p.number) ?? null }))
    })
  )

  orca.panels.handle('job.start', ({ step, target, spec, run, code, backup, purpose }) =>
    guard(() => {
      const t = loadTarget(target)
      if (!existsSync(CLI)) throw new Stop(`CLI 를 찾지 못함: ${CLI}`)
      const busy = listJobs().find((j) => j.target === target && (j.state === 'running' || j.state === 'starting'))
      if (busy) throw new Stop(`${target} 에서 ${LABEL[busy.step]} 작업이 아직 도는 중`)
      const args: string[] = [step]
      if (step === 'plan') {
        if (!spec) throw new Stop('PR 번호 또는 커밋이 필요함')
        args.push('--target', target, spec)
        if (backup) args.push('--backup')
      } else {
        if (!run) throw new Stop('run 이 필요함')
        const r = openRun(run)
        if (r.target.id !== target) throw new Stop(`run ${run} 은 ${r.target.id} 의 run — 지금 고른 대상(${target})과 다름`)
        args.push(run)
        if (step === 'upload' || step === 'rollback') {
          if (!code) throw new Stop('확인 코드가 필요함')
          args.push('--plan', code, '--yes')
        }
      }
      const id = newJobId()
      const job: Job = {
        id,
        step,
        target,
        run: run ?? null,
        spec: spec ?? null,
        state: 'starting',
        message: null,
        progress: null,
        lines: [],
        startedAt: Date.now(),
        endedAt: null,
        pid: null
      }
      // 작업 기록을 먼저 남겨야 진행을 지켜볼 수 있다: 못 남기면 띄우지 않는다.
      if (!writeJob(job, 20)) throw new Stop('작업 기록을 쓰지 못해 시작하지 않음 — 잠시 뒤 다시')
      const child = spawn('node', [CLI, ...args, '--job', id, '--by', 'panel'], {
        cwd: toNative(t.repo),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env
      })
      child.on('error', (e: Error) => {
        writeJob({ ...job, state: 'failed', message: `CLI 를 띄우지 못함: ${e.message}`, endedAt: Date.now() }, 20)
      })
      // 띄운 프로세스 번호는 워커가 기억한다(파일은 다시 쓰지 않음 — CLI 가 먼저 쓴 상태를 덮지 않도록).
      // CLI 의 첫 기록이 실패해 파일만 보면 "끝남"으로 추정되더라도, 이 프로세스가 살아 있으면 계속 지켜본다.
      if (child.pid) spawned.set(id, child.pid)
      child.unref()
      orca.log(`job ${id}: ${args.join(' ').replace(/--plan \S+/, '--plan ********')}`)
      if (purpose === 'configCheck' && step === 'plan') configChecks.add(id)
      watch(id)
      orca.panels.post('job.changed', job)
      void status(job)
      return { jobId: id }
    })
  )

  orca.panels.handle('job.get', ({ id }) => guard(() => readJob(id)))

  orca.panels.handle('jobs.recent', () => guard(() => listJobs().slice(0, 20)))

  orca.panels.handle('runs.list', ({ target }) =>
    guard((): RunSummary[] =>
      listRuns(loadTarget(target)).map((r) => {
        const v = viewRun(r)
        return {
          id: v.id,
          status: v.status,
          statusLabel: v.statusLabel,
          verifyFailed: v.verifyFailed,
          total: v.total,
          uploaded: v.uploaded,
          createdAt: v.createdAt,
          subject: v.subject,
          hidden: isHidden(r)
        }
      })
    )
  )

  orca.panels.handle('runs.hide', ({ target, hidden }) =>
    guard(() => {
      let count = 0
      let kept = 0
      for (const r of listRuns(loadTarget(target))) {
        if (isHidden(r) === hidden) continue
        if (setHidden(r, hidden)) count++
        else kept++
      }
      return { count, kept }
    })
  )

  orca.panels.handle('lock.clear', ({ target }) => guard(() => ({ message: clearStaleLock(target) })))

  orca.panels.handle('run.ack', ({ id }) => guard(() => ({ message: ackWarnings(openRun(id), 'panel') })))

  orca.panels.handle('run.get', ({ id }) =>
    guard(() => {
      const run = openRun(id)
      return { view: viewRun(run), log: logTail(run, 300) }
    })
  )
}
