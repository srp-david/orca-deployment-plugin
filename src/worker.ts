// 플러그인 워커. 짧은 일(대상 설정, 준비 확인, run 목록)은 엔진을 직접 부르고, 운영 FTP 단계
// (plan·backup·upload·verify·rollback)는 같은 엔진의 CLI 를 떨어진 프로세스로 띄운다(ADR 0002):
// 워커가 정리되거나 다시 시작돼도 업로드는 끝까지 가고, 진행은 작업 기록 파일로 이어 본다.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { credentialUser, deleteCredential, writeCredential } from './engine/creds.ts'
import { Ftp, PROBE_SECONDS, resolveAuth, type FtpAuth } from './engine/ftp.ts'
import { gitText, mergedPrs } from './engine/git.ts'
import { jobsDir, listJobs, newJobId, readJob, writeJob, type Job, type JobStep } from './engine/jobs.ts'
import { preflight } from './engine/plan.ts'
import { clearStaleLock, isHidden, listRuns, openRun, setHidden } from './engine/runs.ts'
import { exportChecked, parseShared, repoIdentity, sameRepoIdentity, sharedToTarget } from './engine/share.ts'
import { isDir, mergeSuggestion, suggestFromRepo } from './engine/suggest.ts'
import {
  defaultRuns,
  deleteTarget,
  detectTarget,
  gitRemote,
  listTargets,
  loadTarget,
  mainBranch,
  netrcPath,
  prepareSave,
  repoProblem,
  saveTarget,
  validateTarget,
  type Target
} from './engine/target.ts'
import { exec, expandHome, Stop, toNative } from './engine/util.ts'
import { logTail, viewRun } from './engine/view.ts'
import { cliSpawnError } from './cli-spawn.ts'
import { configVerdict } from './config-verdict.ts'
import { connVerdict, type ConnVerdict } from './conn-verdict.ts'
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
      // 비워 둔 표시 이름·(새 대상의) run 기록 폴더는 기본값으로 채워 저장한다.
      const { target: t, errors } = prepareSave(target, !previousId)
      if (errors.length) return { errors }
      // run 이름과 기록 위치가 대상 이름에 묶여 있어, 이름을 바꾸면 이미 올린 run 을 되돌릴 길이 끊긴다.
      if (previousId && previousId !== t.id)
        return { errors: ['대상 이름은 바꿀 수 없음 — 새 대상으로 만들고 이 대상을 지우세요'] }
      if (!previousId && listTargets().some((x) => x.id === t.id))
        return { errors: [`같은 이름의 대상이 이미 있음: ${t.id}`] }
      saveTarget(t)
      return { errors: [], filled: { label: t.label, runs: t.runs } }
    })
  )

  /** 접속 확인이 도는 대상. 같은 대상에 두 번 겹쳐 접속하지 않는다. */
  const probing = new Set<string>()

  // 접속 확인은 워커가 직접 한다(ADR 0002 의 CLI 작업이 아님): 읽기 한 번이고 시간 제한이 짧아서,
  // 워커가 다시 시작돼 끊겨도 다시 누르면 된다. 사람이 누를 때만 접속하고, 폴더 내용은 돌려주지 않는다.
  orca.panels.handle('conn.check', ({ id }) =>
    guard(async (): Promise<ConnVerdict> => {
      const t = loadTarget(id)
      const busy = listJobs().find((j) => j.target === id && (j.state === 'running' || j.state === 'starting'))
      if (busy) throw new Stop(`${id} 에서 ${LABEL[busy.step]} 작업이 도는 중 — 끝난 뒤 다시 누르세요`)
      if (probing.has(id)) throw new Stop(`${id} 접속 확인이 이미 도는 중`)
      probing.add(id)
      try {
        let auth: FtpAuth
        try {
          auth = await resolveAuth(t)
        } catch (e) {
          if (e instanceof Stop) return { result: 'failed', message: e.message }
          throw e
        }
        const p = await new Ftp(t, auth).probe(t.connection.root, PROBE_SECONDS)
        const v = connVerdict(t, p, PROBE_SECONDS)
        orca.log(`접속 확인 ${id}: ${v.result}${p.ok ? '' : ` (curl ${p.code})`}`)
        return v
      } finally {
        probing.delete(id)
      }
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

  /** 지금 Orca 에서 보고 있는 작업공간의 이름과 폴더. 폴더를 하나로 정하지 못하면 path 는 null. */
  async function currentWorkspace(): Promise<{ name: string | null; path: string | null }> {
    const ctx = await orca.host.call('workspace.readContext').catch(() => null)
    if (!ctx) return { name: null, path: null }
    const list = await orca.host.call('workspace.list').catch(() => null)
    // API 에 공통 id 가 없어 이름·브랜치가 정확히 하나와 맞을 때만 그 경로를 쓴다.
    const hits = (list?.workspaces ?? []).filter(
      (w) => isLocal(w) && w.name === ctx.displayName && (w.branch ?? '') === (ctx.branch ?? '')
    )
    return { name: ctx.displayName, path: hits.length === 1 ? hits[0].path : null }
  }

  /** 이 PC 의 작업공간인가(SSH·WSL 같은 다른 호스트의 것은 Windows 쪽 git 으로 다룰 수 없다). */
  const isLocal = (w: { hostId: string | null }) => !w.hostId || w.hostId === 'local'

  /** 작업공간을 훑을 때 쓰는 git: 폴더 하나가 느리거나 끊겨도(네트워크 드라이브 등) 기다리지 않게 시간을 둔다. */
  const LOOKUP_MS = 5000
  const quickGit = async (dir: string, args: string[]): Promise<string | null> => {
    const r = await exec('git', ['-C', toNative(dir), ...args], { timeoutMs: LOOKUP_MS })
    return r.code === 0 ? r.out.toString('utf8').trim() : null
  }

  /**
   * 폴더의 원격 하나(remote 이름)의 저장소 이름표. 저장소가 아니거나 그 원격이 없거나 이름표로 만들 수 없으면 null.
   * 설정에 적힌 주소를 그대로 읽는다(url.insteadOf 로 바꿔 쓰는 주소는 풀지 않는다).
   */
  async function identityOf(dir: string, remote: string): Promise<string | null> {
    const out = await quickGit(dir, ['config', '--get-regexp', '^remote\\..*\\.url$'])
    if (out === null) return null
    for (const line of out.split('\n')) {
      const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim())
      if (m && m[1] === remote) return repoIdentity(m[2])
    }
    return null
  }

  /**
   * Orca 가 아는 이 PC 의 작업공간 중, 이 이름표의 저장소를 받아 둔 폴더들(저장소 맨 위 폴더와 지금 브랜치).
   * 받는 쪽의 반영은 origin 을 쓰므로 origin 이 그 저장소인 폴더만 본다(upstream 만 같은 fork 는 뺀다).
   * partial: 작업공간이 너무 많거나 시간이 모자라 다 보지 못함.
   */
  async function checkoutsOf(remote: string): Promise<{ found: { path: string; branch: string }[]; partial: boolean }> {
    const list = await orca.host.call('workspace.list').catch(() => null)
    const all = [...new Set((list?.workspaces ?? []).filter(isLocal).map((w) => w.path.replace(/\\/g, '/')))]
    const paths = all.slice(0, 100)
    let partial = !!list?.truncated || all.length > paths.length
    const deadline = Date.now() + 20000
    const found: { path: string; branch: string }[] = []
    const seen = new Set<string>()
    let next = 0
    // 한꺼번에 git 을 100개 띄우지 않고 몇 개씩 나눠 본다.
    const worker = async () => {
      while (next < paths.length) {
        if (Date.now() > deadline) {
          partial = true
          return
        }
        const p = paths[next++]
        const id = await identityOf(p, 'origin')
        if (!id || !sameRepoIdentity(id, remote)) continue
        const top = await quickGit(p, ['rev-parse', '--show-toplevel'])
        if (!top) continue
        const path = top.replace(/\\/g, '/')
        if (seen.has(path.toLowerCase())) continue
        seen.add(path.toLowerCase())
        found.push({ path, branch: (await quickGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? '' })
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker))
    // 고르는 순서가 실행 때마다 달라지지 않게 경로 순으로 둔다.
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { found, partial }
  }

  orca.panels.handle('workspace.detect', () =>
    guard(async (): Promise<Workspace> => {
      const ws = await currentWorkspace()
      if (!ws.path) return { target: null, candidates: [], known: false, name: ws.name, path: null }
      const d = await detectTarget(ws.path)
      return { target: d.target, candidates: d.candidates, known: d.repoKnown, name: ws.name, path: ws.path }
    })
  )

  orca.panels.handle('target.export', ({ id }) =>
    guard(async () => {
      const t = loadTarget(id)
      // 저장소 이름표(계정을 뗀 원격 주소)를 같이 넣는다: 받는 쪽이 자기 PC 에서 같은 저장소를 받아 둔 폴더를 찾는다.
      // 이름표로 만들 수 없는 주소(로컬 경로, file 주소 등)면 넣지 않는다.
      const remote = repoProblem(t.repo) ? null : await identityOf(t.repo, gitRemote(t))
      const { text, errors } = exportChecked(t, remote)
      if (!text) throw new Stop(`이 설정은 내보낼 수 없음 — 받는 쪽에서 거절됩니다. 고친 뒤 다시 내보내세요:\n- ${errors.join('\n- ')}`)
      return { text }
    })
  )

  orca.panels.handle('target.import', ({ text }) =>
    guard(async () => {
      const { shared, errors } = parseShared(text)
      if (!shared) return { errors, draft: null, notes: [] }
      const notes: string[] = []
      const branch = shared.mainBranch ?? 'main'
      // 메인 체크아웃은 제안만 한다. 맞는지는 사람이 보고 저장한다.
      let repo = ''
      const offBranch = (now: string) =>
        `그 폴더는 지금 ${now || '알 수 없는'} 브랜치입니다. 반영은 ${branch} 브랜치에서만 됩니다 — ${branch} 을 받아 둔 폴더가 따로 있으면 그 경로로 고치세요.`
      if (shared.remote) {
        // 받은 설정에 저장소 이름표가 있으면, Orca 작업공간 중 그 저장소를 받아 둔 폴더를 찾는다(main 브랜치인 것부터).
        const { found: all, partial } = await checkoutsOf(shared.remote)
        const onMain = all.filter((c) => c.branch === branch)
        const pick = onMain[0] ?? all[0]
        if (pick) {
          repo = pick.path
          notes.push(`메인 체크아웃에 이 대상의 저장소(${shared.remote})를 받아 둔 폴더 ${repo} 를 넣었습니다. 반영에 쓸 폴더가 맞는지 확인하세요.`)
          if (pick.branch !== branch) notes.push(offBranch(pick.branch))
          const others = (onMain.length ? onMain : all).filter((c) => c !== pick).map((c) => c.path)
          if (others.length) notes.push(`같은 저장소를 받아 둔 다른 폴더: ${others.slice(0, 5).join(', ')}`)
        } else
          notes.push(
            `이 대상의 저장소(${shared.remote})를 받아 둔 작업공간을 Orca 에서 찾지 못했습니다(origin 이 이 주소인 폴더). 저장소를 받은 뒤 메인 체크아웃 경로를 직접 넣으세요.`
          )
        if (partial) notes.push('작업공간이 많거나 응답이 느려서 일부만 찾아봤습니다. 메인 체크아웃이 맞는지 꼭 확인하세요.')
      } else {
        // 이름표가 없는 설정(원격이 없거나, 주소를 이름표로 만들 수 없는 저장소에서 내보낸 것): 지금 보고 있는 작업공간의 저장소를 넣어 본다.
        const ws = await currentWorkspace()
        const top = ws.path ? await gitText(ws.path, ['rev-parse', '--show-toplevel']).catch(() => '') : ''
        if (top) {
          repo = top.replace(/\\/g, '/')
          notes.push(`메인 체크아웃에 지금 작업공간의 저장소(${repo})를 넣었습니다. 이 대상의 저장소가 맞는지 확인하세요.`)
          const now = await gitText(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
          if (now && now !== branch) notes.push(offBranch(now))
        } else notes.push('메인 체크아웃 경로를 직접 넣으세요(지금 작업공간에서 저장소를 찾지 못했습니다).')
      }
      // run 기록에는 운영 백업이 쌓인다. 저장소 안에 두면 실수로 커밋될 수 있어 기본은 플러그인 데이터 폴더 아래다.
      const runs = defaultRuns(shared.id)
      const inside = repo !== '' && (runs.toLowerCase() + '/').startsWith(repo.toLowerCase().replace(/\/+$/, '') + '/')
      notes.push(
        inside
          ? `run 기록 폴더(${runs})가 저장소 안입니다. 운영 파일 백업이 여기에 쌓이니, git 에서 빼 둔 폴더인지 확인하거나 저장소 밖으로 고치세요.`
          : `run 기록 폴더는 ${runs} 로 넣었습니다. 운영 파일 백업이 여기에 쌓입니다.`
      )
      if (!shared.checkCommit)
        notes.push('받은 설정에 확인용 커밋이 없습니다. 설정 확인을 하려면 이미 운영에 반영된 커밋을 넣고 저장하세요.')
      // 빌드 명령은 개인 경로가 섞일 수 있어 내보내지 않는다.
      if (shared.java)
        notes.push("받은 설정에 빌드 명령은 들어 있지 않습니다. Java 를 반영하려면 '저장소에서 채우기'로 제안을 받거나, 보낸 사람에게 물어 넣으세요.")
      if (listTargets().some((t) => t.id === shared.id))
        notes.push(
          `같은 이름의 대상(${shared.id})이 이미 있습니다. 덮어쓰지 않습니다 — 그 대상을 고쳐 쓰거나, 이름을 바꿔 저장하세요(이름을 바꾸면 run 기록 폴더 끝의 이름도 같이 고치세요).`
        )
      return { errors: [], draft: sharedToTarget(shared, repo, runs), notes }
    })
  )

  orca.panels.handle('target.suggest', ({ target, tidy }) =>
    guard(async () => {
      const none = (why: string) => ({ errors: [why], draft: null, notes: [] })
      // 아직 저장하지 않은 초안이라 빈 칸이 있을 수 있다. 폴더를 읽기 전에 여기서 쓰는 칸의 모양만 본다.
      const str = (v: unknown): v is string => typeof v === 'string'
      const shaped =
        !!target &&
        typeof target === 'object' &&
        Array.isArray(target.mappings) &&
        target.mappings.every((m) => !!m && str(m.local) && str(m.remote)) &&
        Array.isArray(target.manual) &&
        target.manual.every((r) => !!r && str(r.pattern) && str(r.reason)) &&
        (target.java === undefined || (!!target.java && str(target.java.source) && str(target.java.output)))
      if (!shaped) return none('설정의 형식이 틀려서 채우지 못함 — 편집기를 닫고 다시 여세요')
      const typed = str(target.repo) ? expandHome(target.repo.trim()) : ''
      if (!typed) return none('메인 체크아웃 경로를 먼저 넣으세요')
      const missing = repoProblem(typed)
      if (missing) return none(missing)
      // 매핑의 로컬 경로는 저장소 맨 위 기준이다. 저장소 안의 하위 폴더를 넣었으면 맨 위로 바꾼다.
      const top = await quickGit(typed, ['rev-parse', '--show-toplevel'])
      if (!top) return none(`git 저장소가 아님: ${typed} — main 을 받아 두고 빌드하는 저장소 폴더를 넣으세요`)
      const slashed = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
      const root = slashed(top)
      const same = root.toLowerCase() === slashed(typed).toLowerCase()
      const { target: draft, notes } = mergeSuggestion({ ...target, repo: same ? target.repo : root }, await suggestFromRepo(root), {
        tidy: !!tidy,
        // 저장소 밖을 가리키는 경로(.., 절대 경로)는 들여다보지 않는다. 그런 매핑은 저장할 때 따로 거절된다.
        exists: (rel) => /(^|\/)\.\.(\/|$)/.test(rel) || /^[a-zA-Z]:|^\//.test(rel) || isDir(`${root}/${rel}`)
      })
      if (!same) notes.unshift(`메인 체크아웃을 저장소 맨 위 폴더 ${root} 로 바꿨습니다.`)
      if (notes.length === 0) notes.push('지금 설정이 저장소 구조와 맞습니다. 바꾼 것이 없습니다.')
      return { errors: [], draft, notes }
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
      // CLI 는 메인 체크아웃에서 띄운다. 폴더가 없으면 spawn 이 "node ENOENT" 로만 알려 줘서 원인을 알 수 없다.
      const cwd = toNative(t.repo)
      const missing = repoProblem(t.repo)
      if (missing) throw new Stop(missing)
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
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env
      })
      child.on('error', (e: Error) => {
        writeJob({ ...job, state: 'failed', message: cliSpawnError(e, t.repo), endedAt: Date.now() }, 20)
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

  orca.panels.handle('run.get', ({ id }) =>
    guard(() => {
      const run = openRun(id)
      return { view: viewRun(run), log: logTail(run, 300) }
    })
  )
}
