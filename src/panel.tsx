// 운영 반영 패널. 순서: 대상 → PR/커밋 → 준비 확인 → Plan → 반영 목록 → Backup → Upload → Verify (되돌리기는 따로).
// 운영 FTP 단계는 워커가 CLI 로 띄우고(ADR 0002), 진행은 'job.changed' 로 받는다.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Field,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
  Markdown,
  plugin,
  Progress,
  read,
  Row,
  Select,
  Separator,
  set,
  Spinner,
  Stack,
  Switch,
  Tab,
  Table,
  Tabs,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import type {
  Job,
  JobStep,
  PreflightView,
  RecentPr,
  RunSummary,
  RunView,
  Target,
  TargetDetail,
  TargetSummary,
  Workspace
} from './protocol.ts'

// ── 상태 ──────────────────────────────────────────────────────

const targets = atom<TargetSummary[]>([])
/** 대상 목록을 한 번이라도 받았거나 끝내 못 받았는가. 그 전에는 "대상이 없음" 대신 불러오는 중으로 보인다. */
const targetsLoaded = atom(false)
/** 마지막에 고른 대상(작업공간으로 못 고를 때 쓴다). */
const targetId = atom('targetId', '', { persist: 'plugin' })
const workspace = atom<Workspace | null>(null)
const tab = atom('deploy')
const spec = atom('')
const checking = atom(false)
const preflight = atom<{ target: string; spec: string; view: PreflightView } | null>(null)
const runId = atom<string | null>(null)
const detail = atom<{ view: RunView; log: string[] } | null>(null)
const runs = atom<RunSummary[]>([])
const jobs = atom<Record<string, Job>>({})
const error = atom<string | null>(null)
/** 이 화면에서 Plan 을 눌러 띄운 작업. 그 작업의 결과만 반영 목록으로 연다(늦게 온 다른 plan 결과가 끼지 않게). */
const pendingPlan = atom<string | null>(null)
/** 대상 저장소 main 에 최근 병합된 PR. null 은 불러오는 중. */
const prs = atom<RecentPr[] | null>(null)
const prsError = atom<string | null>(null)

// 대상 설정 편집
const editing = atom<{ draft: Target; previousId: string | null; credUser: string | null; netrc: boolean } | null>(null)
const editErrors = atom<string[]>([])
const editNotice = atom<string | null>(null)
const cred = atom({ user: '', password: '' })
const mapForm = atom({ local: '', remote: '' })
const mapSel = atom<string | null>(null)
const ruleForm = atom({ pattern: '', reason: '' })
const ruleSel = atom<string | null>(null)
/** "설정 확인"으로 띄운 plan 작업. */
const configCheck = atom<{ jobId: string; target: string; result: string | null; ok: boolean | null } | null>(null)

const STEP_LABEL: Record<JobStep, string> = {
  check: '준비 확인',
  plan: '반영 목록 만들기',
  backup: '백업',
  upload: '업로드',
  verify: '대조',
  rollback: '되돌리기'
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 워커에 묻는다. 실패하면 오류 띠에 남긴다. 오류 띠는 사람이 닫거나 다음 동작을 시작할 때만 지운다
 *  (뒤이은 다른 요청의 성공이 앞 요청의 실패를 지워 버리지 않도록). */
async function ask<T>(body: () => Promise<T>): Promise<T | null> {
  try {
    return await body()
  } catch (e) {
    set(error, message(e))
    return null
  }
}

/** 워커로 보내는 값에서 undefined 칸을 뺀다. Orca 는 JSON 이 아닌 값이 섞인 요청을
 *  "input: Invalid input" 으로 거절한다. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 사람이 동작을 시작할 때: 지난 오류 띠를 지운다. */
function act(): void {
  set(error, null)
}

// ── 불러오기 ──────────────────────────────────────────────────

async function loadTargets(): Promise<void> {
  const list = await ask(() => plugin.request('targets.list'))
  if (!list) return
  set(targets, list)
  set(targetsLoaded, true)
  const ws = read(workspace)
  const current = read(targetId)
  if (ws?.target && list.some((t) => t.id === ws.target)) {
    if (ws.target !== current) chooseTarget(ws.target, true)
    else void loadRuns()
  } else if (!list.some((t) => t.id === current)) {
    // 작업공간으로도, 마지막 선택으로도 못 정하면: 시험용이 아닌 대상이 하나뿐일 때만 고른다. 시험용은 고르지 않는다.
    const real = list.filter((t) => !t.test)
    chooseTarget(real.length === 1 ? real[0].id : '', true)
  } else void loadRuns()
}

async function detectWorkspace(): Promise<void> {
  const ws = await ask(() => plugin.request('workspace.detect'))
  if (!ws) return
  set(workspace, ws)
  if (ws.target && ws.target !== read(targetId) && read(targets).some((t) => t.id === ws.target)) chooseTarget(ws.target, true)
}

async function loadRuns(): Promise<void> {
  const id = read(targetId)
  if (!id) return set(runs, [])
  const list = await ask(() => plugin.request('runs.list', { target: id }))
  if (list && read(targetId) === id) set(runs, list)
}

async function loadRun(id: string): Promise<void> {
  const d = await ask(() => plugin.request('run.get', { id }))
  if (d && read(runId) === id) set(detail, d)
}

/** 대상을 바꾸면 준비 확인·plan·확인 코드를 버린다(잘못된 대상에 올리지 않도록). */
function chooseTarget(id: string, force = false): void {
  if (!force && id === read(targetId)) return
  set(targetId, id)
  set(preflight, null)
  set(runId, null)
  set(detail, null)
  set(runs, [])
  set(pendingPlan, null)
  set(spec, '')
  void loadRuns()
  void loadPrs()
}

/** 작업 기록을 파일에서 다시 읽는다. 이벤트를 놓쳐 "도는 중"으로 남은 작업도 이것으로 바로잡힌다. */
async function loadJobs(): Promise<void> {
  const recent = await ask(() => plugin.request('jobs.recent'))
  if (recent) set(jobs, Object.fromEntries(recent.map((j) => [j.id, j])))
}

async function refresh(): Promise<void> {
  act()
  await detectWorkspace()
  await loadTargets()
  await loadJobs()
  void loadPrs()
  const id = read(runId)
  if (id) await loadRun(id)
}

function openRun(id: string): void {
  set(runId, id)
  set(detail, null)
  void loadRun(id)
}

// ── 동작 ──────────────────────────────────────────────────────

async function loadPrs(): Promise<void> {
  const id = read(targetId)
  set(prsError, null)
  if (!id) return set(prs, [])
  set(prs, null)
  try {
    const list = await plugin.request('prs.recent', { target: id }, { timeoutMs: 60000 })
    if (read(targetId) === id) set(prs, list)
  } catch (e) {
    if (read(targetId) === id) {
      set(prs, [])
      set(prsError, message(e))
    }
  }
}

async function start(step: JobStep, extra: { spec?: string; run?: string; code?: string; backup?: boolean }): Promise<string | null> {
  const target = read(targetId)
  const r = await ask(() => plugin.request('job.start', plain({ step, target, ...extra })))
  return r?.jobId ?? null
}

/** PR 을 고르거나 직접 입력: 고르기만 한다. 다른 것을 고르면 앞의 준비 확인·반영 목록은 내린다. */
function selectSpec(value: string): void {
  set(spec, value)
  const p = read(preflight)
  if (p && p.spec !== value.trim()) {
    set(preflight, null)
    set(runId, null)
    set(detail, null)
    set(pendingPlan, null)
  }
}

/** 처음 화면으로: 고른 PR·준비 확인·열린 반영 목록을 비운다. run 은 지우지 않는다(run 기록 탭에 남음). */
function resetDeploy(): void {
  act()
  set(spec, '')
  set(preflight, null)
  set(runId, null)
  set(detail, null)
  set(pendingPlan, null)
  void plugin.request('status.reset').catch(() => {})
}

/** 반영 목록 만들기: 준비 확인 → (통과하면) plan → 백업. 운영은 읽기만 한다.
 *  준비 확인이 실패하면 그 자리에서 멈추고 할 일을 보여 준다. */
async function prepare(text: string): Promise<void> {
  act()
  const target = read(targetId)
  const s = text.trim()
  if (!target || !s || read(checking) || activeJob(target)) return
  set(spec, s)
  set(checking, true)
  set(preflight, null)
  set(runId, null)
  set(detail, null)
  set(pendingPlan, null)
  const view = await ask(() => plugin.request('check', { target, spec: s }, { timeoutMs: 120000 }))
  set(checking, false)
  if (!view || read(targetId) !== target) return
  set(preflight, { target, spec: s, view })
  if (!view.ok) return
  const jobId = await start('plan', { spec: s, backup: true })
  if (jobId && read(targetId) === target) set(pendingPlan, jobId)
}

async function runStep(step: 'backup' | 'upload' | 'verify' | 'rollback'): Promise<void> {
  act()
  const d = read(detail)
  if (!d) return
  await start(step, { run: d.view.id, code: step === 'upload' || step === 'rollback' ? (d.view.code ?? '') : undefined })
}

async function clearLock(target: string, run: string): Promise<void> {
  act()
  const r = await ask(() => plugin.request('lock.clear', { target }))
  if (r && read(runId) === run) await loadRun(run)
}

function onJob(job: Job): void {
  update(jobs, (all) => ({ ...all, [job.id]: job }))
  const cc = read(configCheck)
  if (cc && cc.jobId === job.id && (job.state === 'done' || job.state === 'failed')) void finishConfigCheck(job)
  if (job.target !== read(targetId)) return
  if (job.step === 'plan' && job.run && job.id === read(pendingPlan)) {
    if (read(runId) !== job.run) openRun(job.run)
  }
  if (job.state === 'done' || job.state === 'failed') {
    if (job.run && read(runId) === job.run) void loadRun(job.run)
    void loadRuns()
    if (job.step === 'plan' || job.step === 'upload' || job.step === 'rollback') void loadPrs()
  }
}

// ── 대상 설정 ─────────────────────────────────────────────────

function blankTarget(): Target {
  return {
    id: '',
    label: '',
    repo: '',
    mainBranch: 'main',
    runs: '',
    connection: { protocol: 'ftp', host: '', port: 21, root: '/', passive: true },
    mappings: [{ local: 'src/main/webapp', remote: '/' }],
    manual: []
  }
}

async function editTarget(id: string | null): Promise<void> {
  act()
  set(editErrors, [])
  set(editNotice, null)
  set(cred, { user: '', password: '' })
  set(mapSel, null)
  set(ruleSel, null)
  set(configCheck, null)
  if (!id) return set(editing, { draft: blankTarget(), previousId: null, credUser: null, netrc: false })
  const d: TargetDetail | null = await ask(() => plugin.request('target.get', { id }))
  if (d) {
    set(editing, { draft: d.target, previousId: id, credUser: d.credUser, netrc: d.netrc })
    set(cred, { user: d.credUser ?? '', password: '' })
  }
}

function patch(fn: (t: Target) => Target): void {
  update(editing, (e) => (e ? { ...e, draft: fn(e.draft) } : e))
}

async function saveEdit(): Promise<void> {
  act()
  const e = read(editing)
  if (!e) return
  const r = await ask(() => plugin.request('target.save', plain({ target: e.draft, previousId: e.previousId })))
  if (!r) return
  set(editErrors, r.errors)
  if (r.errors.length) return
  set(editNotice, '저장함')
  set(editing, { ...e, previousId: e.draft.id })
  // 설정이 바뀌면 그 대상의 준비 확인·plan 을 버린다.
  if (read(targetId) === e.draft.id || read(targetId) === e.previousId) chooseTarget(e.draft.id, true)
  await loadTargets()
}

async function deleteEdit(): Promise<void> {
  act()
  const e = read(editing)
  if (!e?.previousId) return
  await ask(() => plugin.request('target.delete', { id: e.previousId! }))
  set(editing, null)
  await loadTargets()
}

async function saveCred(): Promise<void> {
  act()
  const e = read(editing)
  const c = read(cred)
  if (!e?.previousId || !c.user.trim()) return
  const r = await ask(() => plugin.request('creds.set', { id: e.previousId!, user: c.user, password: c.password }))
  if (r) {
    set(editing, { ...e, credUser: r.user })
    set(cred, { user: r.user, password: '' })
    set(editNotice, `접속 정보 저장함 (사용자 ${r.user})`)
  }
}

async function startConfigCheck(): Promise<void> {
  act()
  const e = read(editing)
  if (!e?.previousId || !e.draft.checkCommit) return
  const target = e.previousId
  const r = await ask(() => plugin.request('job.start', { step: 'plan', target, spec: e.draft.checkCommit! }))
  if (r) set(configCheck, { jobId: r.jobId, target, result: null, ok: null })
}

/** 확인용 커밋 plan: 모든 파일이 "이미 반영됨"이어야 하고, 운영에 없는 경로(새 파일)가 없어야 한다. */
async function finishConfigCheck(job: Job): Promise<void> {
  if (!job.run) {
    set(configCheck, { jobId: job.id, target: job.target, ok: false, result: job.message ?? '준비 확인 실패' })
    return
  }
  const d = await ask(() => plugin.request('run.get', { id: job.run! }))
  if (!d) return
  const v = d.view
  const done = v.errors.filter((x) => /이미 반영됨/.test(x)).length
  const other = v.errors.filter((x) => !/이미 반영됨|main 에 이후 변경/.test(x))
  const fresh = v.rows.filter((r) => r.kind === 'A')
  const ok = done > 0 && other.length === 0 && fresh.length === 0
  const lines = [
    ok ? `맞음: ${done}개 파일이 운영에 이미 반영돼 있음` : '설정을 다시 보세요',
    ...other.map((x) => `· ${x}`),
    ...fresh.map((r) => `· 운영에 없는 경로(매핑 확인): ${r.remote}`)
  ]
  if (!done && !other.length && !fresh.length) lines.push('· 이미 반영된 파일을 하나도 찾지 못함')
  set(configCheck, { jobId: job.id, target: job.target, ok, result: lines.join('\n') })
}

// ── 시작 ──────────────────────────────────────────────────────

/** 처음 불러오기. 패널은 워커가 막 다시 시작되는 순간에 열릴 수 있어서, 대상 목록을 받을 때까지 몇 번 다시 시도한다. */
async function firstLoad(signal: AbortSignal): Promise<void> {
  for (let i = 0; i < 8 && !signal.aborted; i++) {
    try {
      const list = await plugin.request('targets.list')
      set(targets, list)
      set(targetsLoaded, true)
      set(error, null)
      break
    } catch (e) {
      if (i === 7) {
        set(error, `워커에 연결하지 못함: ${message(e)} — 다시 불러오기를 누르세요`)
        set(targetsLoaded, true)
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  await detectWorkspace()
  await loadTargets()
  await loadJobs()
  await loadPrs()
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('job.changed', onJob))
  void firstLoad(ctx.signal)
  // 보이는지를 1초마다 워커에 알린다(상태 표시줄을 다시 누르면 닫기). 패널이 닫히며 못 알려도
  // 워커는 3초 넘게 소식이 없으면 안 보이는 것으로 본다.
  const report = () => void plugin.request('panel.visible', { visible: read(ctx.visible) }).catch(() => {})
  report()
  const timer = setInterval(report, 1000)
  // 시험(Node)에서 패널을 닫지 못하고 끝나도 프로세스를 붙잡지 않게.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  ctx.signal.addEventListener('abort', () => clearInterval(timer))
}

// ── 화면 ──────────────────────────────────────────────────────

function currentTarget(): TargetSummary | null {
  return read(targets).find((t) => t.id === read(targetId)) ?? null
}

function activeJob(target: string): Job | null {
  const list = Object.values(read(jobs))
    .filter((j) => j.target === target)
    .sort((a, b) => b.startedAt - a.startedAt)
  return list.find((j) => j.state === 'running' || j.state === 'starting') ?? null
}

function lastJob(target: string, run: string | null): Job | null {
  const list = Object.values(read(jobs))
    .filter((j) => j.target === target && (run === null || j.run === run))
    .sort((a, b) => b.startedAt - a.startedAt)
  return list[0] ?? null
}

function TargetCard() {
  const list = read(targets)
  const t = currentTarget()
  const ws = read(workspace)
  if (!list.length && !read(targetsLoaded)) return <Spinner label="대상 불러오는 중" />
  if (!list.length)
    return (
      <EmptyState title="대상이 없음" description="대상 설정 탭에서 대상을 추가하세요." icon="settings">
        <Row gap="xs">
          <Button onPress={() => (set(tab, 'targets'), void editTarget(null))}>대상 추가</Button>
          <Button variant="outline" icon="refresh" onPress={refresh}>
            다시 불러오기
          </Button>
        </Row>
      </EmptyState>
    )
  let wsNote: { tone: 'warning' | 'neutral'; text: string } | null = null
  if (!ws || !ws.known) wsNote = { tone: 'neutral', text: '작업공간 저장소를 알 수 없음 — 대상을 직접 확인하세요' }
  else if (t && !ws.candidates.includes(t.id) && !t.test)
    wsNote = { tone: 'warning', text: `작업공간(${ws.name ?? ws.path})의 저장소와 이 대상의 저장소가 다름` }
  else if (t?.test) wsNote = { tone: 'neutral', text: '시험용 대상' }
  return (
    <Card title="대상" description="반영할 운영 서버">
      <Stack gap="sm">
        <Box direction="row" gap="xs" align="center">
          <Box grow>
            <Select
              label="대상"
              labelHidden
              value={t?.id ?? ''}
              placeholder="대상 고르기"
              options={list.map((x) => ({ value: x.id, label: `${x.label}${x.test ? ' (시험용)' : ''}` }))}
              onChange={(v) => chooseTarget(v)}
            />
          </Box>
          <IconButton icon="refresh" label="다시 불러오기" variant="ghost" onPress={refresh} />
        </Box>
        {!t && (
          <Text muted size="xs">
            작업공간 저장소로 대상을 정하지 못함 — 대상을 직접 고르세요
          </Text>
        )}
        {t && (
          <KeyValue
            items={[
              { label: 'FTP', value: `${t.host}${t.port !== 21 ? ':' + t.port : ''}`, code: true },
              { label: '운영 루트', value: t.root, code: true },
              { label: '메인 체크아웃', value: t.repo, code: true }
            ]}
          />
        )}
        {wsNote &&
          (wsNote.tone === 'warning' ? (
            <Callout tone="warning" icon="warning">
              {wsNote.text}
            </Callout>
          ) : (
            <Text muted size="xs">
              {wsNote.text}
            </Text>
          ))}
      </Stack>
    </Card>
  )
}

const DEPLOY_LABEL: Record<NonNullable<RecentPr['deploy']>, string> = {
  deployed: '반영됨',
  partial: '부분 업로드',
  planned: '목록 만듦'
}

/** 병합 시각을 "11-06 18:08" 처럼 짧게. */
function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function ChangeCard() {
  const t = currentTarget()
  if (!t) return null
  const p = read(preflight)
  const busy = read(checking)
  const locked = busy || !!activeJob(t.id)
  const list = read(prs)
  const current = read(spec)
  return (
    <Card title="반영할 PR" description="PR 을 고르고 반영 목록 만들기를 누르세요 (준비 확인 → plan → 백업, 운영은 읽기만)">
      <Stack gap="sm">
        {list === null ? (
          <Spinner label="병합된 PR 불러오는 중" />
        ) : list.length > 0 ? (
          <Box border radius="md" maxHeight={300} scroll="y">
            <List label="최근 병합된 PR">
              {list.map((pr) => (
                <ListItem
                  key={`pr${pr.number}`}
                  icon={pr.deploy === 'deployed' ? 'check' : pr.deploy === 'partial' ? 'warning' : 'branch'}
                  title={`#${pr.number} ${pr.title}`}
                  description={[shortTime(pr.mergedAt), pr.deploy ? DEPLOY_LABEL[pr.deploy] : ''].filter(Boolean).join(' · ')}
                  current={current === `#${pr.number}`}
                  disabled={locked}
                  onPress={() => selectSpec(`#${pr.number}`)}
                />
              ))}
            </List>
          </Box>
        ) : (
          <Text muted size="sm">
            {read(prsError) ? `PR 목록을 받지 못함: ${read(prsError)}` : '최근 병합된 PR 없음'}
          </Text>
        )}
        <Input
          label="PR 번호 또는 커밋"
          labelHidden
          placeholder="고른 PR · 직접 입력: #123 · 커밋 · 기준..끝"
          value={current}
          onChange={(v) => selectSpec(v)}
          onSubmit={() => void prepare(read(spec))}
        />
        <Box direction="row" gap="xs" justify="end">
          <Button icon="close" variant="ghost" disabled={locked} onPress={resetDeploy}>
            초기화
          </Button>
          <Button icon="play" tone="accent" disabled={locked || !current.trim()} onPress={() => prepare(read(spec))}>
            반영 목록 만들기
          </Button>
        </Box>
        {busy && <Spinner label="준비 확인 중 (fetch·PR 조회)" />}
        {p && p.view.ok && (
          <Text size="xs" muted>
            {`✓ 준비 확인 통과 — ${p.view.items.map((i) => i.title).join(' · ')}`}
          </Text>
        )}
        {p && !p.view.ok && (
          <Stack gap="sm">
            <Separator />
            <Stack gap="xs">
              <Text weight="semibold">{p.view.subject ?? p.spec}</Text>
              <Text size="xs" tone="danger">
                준비 확인에서 멈춤 — 아래를 고친 뒤 다시 확인하세요
              </Text>
            </Stack>
            <List label="준비 확인">
              {p.view.items.map((i) => (
                <ListItem key={i.id} icon={i.ok ? 'check' : 'error'} title={i.title} description={i.detail.join(' · ') || undefined} />
              ))}
            </List>
            {p.view.items
              .filter((i) => i.fix)
              .map((i) => (
                <Field key={`fix-${i.id}`} label={`할 일: ${i.title}`} description="메인 체크아웃에서 실행한 뒤 다시 확인">
                  <CodeView code={i.fix!} language="powershell" wrap />
                </Field>
              ))}
            <Box direction="row" justify="end">
              <Button icon="refresh" variant="outline" disabled={locked} onPress={() => prepare(p.spec)}>
                다시 확인
              </Button>
            </Box>
          </Stack>
        )}
      </Stack>
    </Card>
  )
}

function JobProgress({ job }: { job: Job }) {
  const running = job.state === 'running' || job.state === 'starting'
  return (
    <Stack gap="xs">
      {running && job.progress ? (
        <Progress label={`${STEP_LABEL[job.step]} ${job.progress.n}/${job.progress.total}`} value={(job.progress.n / job.progress.total) * 100} />
      ) : running ? (
        <Spinner label={`${STEP_LABEL[job.step]} 중`} />
      ) : null}
      {job.state === 'failed' && (
        <Callout tone="danger" title={`${STEP_LABEL[job.step]} 실패`} icon="error">
          {job.message ?? ''}
        </Callout>
      )}
      {job.lines.length > 0 && (
        <Collapsible title={`${STEP_LABEL[job.step]} 출력 (${job.lines.length}줄)`} defaultOpen={running || job.state === 'failed'}>
          <CodeView code={job.lines.slice(-80).join('\n')} maxHeight="md" wrap />
        </Collapsible>
      )}
    </Stack>
  )
}

function RunCard() {
  const t = currentTarget()
  const d = read(detail)
  const id = read(runId)
  if (!t) return null
  const job = activeJob(t.id)
  const planJob = job && job.step === 'plan' ? job : null
  if (!id && !planJob) return null
  if (!d) return planJob ? <JobProgress job={planJob} /> : <Spinner label="run 불러오는 중" />
  const v = d.view
  const busy = !!job || !!v.busy
  const last = lastJob(t.id, v.id)
  const canBackup = !v.configChanged && (v.status === 'planned' || v.status === 'backedUp')
  const canUpload = !v.configChanged && v.status === 'backedUp'
  const canVerify = v.status === 'uploaded' || v.status === 'verified'
  const canRollback = v.status === 'partial' || v.status === 'uploaded' || v.status === 'verified'
  const tone = v.status === 'blocked' ? 'danger' : v.status === 'verified' ? 'success' : v.status === 'partial' ? 'warning' : 'accent'
  return (
    <Card title="반영 목록" description={v.subject || undefined}>
      <Stack gap="sm">
        <Box direction="row" gap="xs" align="center" justify="between" wrap>
          <Row gap="xs" wrap>
            <Badge tone={tone}>{v.statusLabel}{v.status === 'partial' ? ` ${v.uploaded}/${v.total}` : ''}</Badge>
            {v.verifyFailed && <Badge tone="danger">대조 실패</Badge>}
          </Row>
          {v.code && <Badge tone="neutral">확인 코드 {v.code}</Badge>}
        </Box>
        <KeyValue
          label="이 run 의 반영 위치"
          items={[
            { label: '대상', value: v.label },
            { label: 'FTP', value: `${v.host}${v.port !== 21 ? ':' + v.port : ''}`, code: true, tone: v.configChanged ? 'warning' : undefined },
            { label: '운영 루트', value: v.root, code: true, tone: v.configChanged ? 'warning' : undefined },
            { label: 'run', value: v.id, code: true }
          ]}
        />
        {v.configChanged && (
          <Callout tone="warning" title="대상 설정이 이 run 을 만든 뒤 바뀜" icon="warning">
            백업·업로드는 하지 않습니다. 새로 plan 하세요. 되돌리기는 위에 적힌 이 run 의 위치로 합니다.
          </Callout>
        )}
        {v.errors.length > 0 && (
          <Callout tone="danger" title={`문제 ${v.errors.length}건 — 이 run 은 올리지 않음`} icon="error">
            <Stack gap="xs">
              {v.errors.map((e, i) => (
                <Text key={`e${i}`} size="xs">
                  {e}
                </Text>
              ))}
              <Text size="xs" muted>
                고친 뒤 준비 확인부터 새로 하세요.
              </Text>
            </Stack>
          </Callout>
        )}
        {v.pr?.notes && (
          <Collapsible title={`PR #${v.pr.number} 반영 시 주의`} defaultOpen>
            <Markdown content={v.pr.notes} />
          </Collapsible>
        )}
        {v.hasClass && (
          <Callout tone="warning" icon="warning">
            class 포함 — 올린 뒤 톰캣 재기동 필요
          </Callout>
        )}
        {v.rows.length === 0 ? (
          <Text muted size="sm">
            올릴 파일 없음
          </Text>
        ) : (
          <Box border radius="md" maxHeight={420} scroll="y">
            <List label="반영 목록">
              {v.rows.map((r, i) => (
                <ListItem
                  key={`r${i}`}
                  icon={r.kind === 'M' ? 'file' : 'add'}
                  title={r.local}
                  description={`${r.kind === 'M' ? '덮어씀' : '새 파일'} → ${r.remote}${r.note ? ' · ' + r.note : ''}`}
                />
              ))}
            </List>
          </Box>
        )}
        {v.manual.length > 0 && (
          <Collapsible title={`손 처리 파일 ${v.manual.length}개 (올리지 않음)`} defaultOpen>
            <List label="손 처리 파일">
              {v.manual.map((m, i) => (
                <ListItem key={`m${i}`} icon="wrench" title={m.path} description={m.reason} />
              ))}
            </List>
          </Collapsible>
        )}
        {v.notes.length > 0 && (
          <Collapsible title={`빌드 폴더의 옛 내부 클래스 ${v.notes.length}개 (올리지 않음)`}>
            <List label="옛 내부 클래스">
              {v.notes.map((m, i) => (
                <ListItem key={`n${i}`} icon="file" title={m.path} description={m.reason} />
              ))}
            </List>
          </Collapsible>
        )}
        {v.skip.length > 0 && (
          <Collapsible title={`매핑 밖 파일 ${v.skip.length}개`}>
            <List label="매핑 밖 파일">
              {v.skip.map((m, i) => (
                <ListItem key={`s${i}`} icon="file" title={m.path} />
              ))}
            </List>
          </Collapsible>
        )}
        {v.busy && !job && (
          <Callout tone="warning" icon="warning">
            {`이 대상에서 다른 작업 중: ${v.busy}`}
          </Callout>
        )}
        {v.staleLock && !v.busy && !job && (
          <Callout tone="warning" title="끝난 작업의 잠금이 남아 있음" icon="warning">
            <Stack gap="xs">
              <Text size="xs">{`${v.staleLock} — 그 작업이 정말 끝났는지(다른 창·터미널) 본 뒤에 푸세요. 풀기 전에는 백업·업로드·되돌리기가 막힙니다.`}</Text>
              <Button size="sm" variant="outline" icon="close" onPress={() => clearLock(v.target, v.id)}>
                잠금 풀기
              </Button>
            </Stack>
          </Callout>
        )}
        {(v.status === 'planned' || v.status === 'backedUp') && (
          <Stack gap="xs" align="stretch">
            <Separator />
            {v.status === 'planned' && (
              <>
                <Text size="xs" muted>
                  백업이 아직 없음 — 백업을 받아야 올릴 수 있습니다.
                </Text>
                <Button icon="download" variant="outline" disabled={busy || !canBackup} onPress={() => runStep('backup')}>
                  백업
                </Button>
              </>
            )}
            <Button icon="upload" tone="danger" disabled={busy || !canUpload} onPress={() => runStep('upload')}>
              {`${v.label}에 ${v.total}개 업로드`}
            </Button>
            <Text size="xs" muted>
              누르면 운영 파일을 다시 대조한 뒤 올리고, 올린 뒤 바로 대조합니다. 이 버튼이 최종 확인입니다.
            </Text>
          </Stack>
        )}
        {v.status === 'uploaded' && (
          <Stack gap="xs" align="stretch">
            <Separator />
            <Text size="xs" muted>
              {v.verifyFailed ? '올린 뒤 대조가 맞지 않았습니다. 다시 대조하거나 되돌리세요.' : '업로드는 끝났고 대조가 아직 없습니다.'}
            </Text>
            <Button icon="check" variant="outline" disabled={busy || !canVerify} onPress={() => runStep('verify')}>
              다시 대조
            </Button>
          </Stack>
        )}
        {v.status === 'partial' && (
          <Callout tone="danger" title={`부분 업로드 ${v.uploaded}/${v.total}`} icon="error">
            이어 올리지 않습니다. 아래에서 되돌린 뒤 새로 plan 하세요.
          </Callout>
        )}
        {v.status === 'verified' && <Remaining v={v} />}
        {canRollback && (
          <Collapsible title="되돌리기" defaultOpen={v.status === 'partial' || v.verifyFailed}>
            <Stack gap="xs">
              <Text size="xs">
                {`덮어쓴 파일은 백업(${v.backupDir ?? '-'})으로 되올리고, 새로 만든 파일은 지웁니다.`}
              </Text>
              <Button icon="refresh" tone="danger" variant="outline" disabled={busy} onPress={() => runStep('rollback')}>
                {`${v.label} 되돌리기 (${v.total}개)`}
              </Button>
            </Stack>
          </Collapsible>
        )}
        {job && job.run === v.id && <JobProgress job={job} />}
        {!job && last && last.state === 'failed' && last.run === v.id && <JobProgress job={last} />}
      </Stack>
    </Card>
  )
}

function Remaining({ v }: { v: RunView }) {
  const items: string[] = []
  if (v.hasClass) items.push('톰캣 재기동')
  if (v.pr?.notes) items.push(`PR #${v.pr.number} "반영 시 주의"의 SQL·등록 순서`)
  if (v.manual.length) items.push(`손 처리 파일 ${v.manual.length}개`)
  items.push('재로그인해서 화면 확인', 'HISTORY.md 갱신')
  return (
    <Callout tone="success" title="운영 = 로컬, 남은 사람 할 일" icon="check">
      <Stack gap="xs">
        {items.map((x, i) => (
          <Text key={`t${i}`} size="xs">
            {`· ${x}`}
          </Text>
        ))}
      </Stack>
    </Callout>
  )
}

function DeployTab() {
  return (
    <Stack gap="md">
      <TargetCard />
      <ChangeCard />
      <RunCard />
    </Stack>
  )
}

function RunsTab() {
  const t = currentTarget()
  const list = read(runs)
  const d = read(detail)
  if (!t) return <EmptyState title="대상을 고르세요" />
  return (
    <Stack gap="sm">
      <Row justify="between">
        <Text weight="medium">{`${t.label} run 기록`}</Text>
        <Button icon="refresh" variant="ghost" size="sm" onPress={loadRuns}>
          새로 고침
        </Button>
      </Row>
      <Table
        label="run 기록"
        maxHeight="md"
        emptyText="run 없음"
        selectionMode="single"
        selected={read(runId) ? [read(runId)!] : []}
        onSelectionChange={({ keys }) => keys[0] && openRun(keys[0])}
        onRowAction={({ key }) => {
          openRun(key)
          set(tab, 'deploy')
        }}
        columns={[
          { key: 'at', label: '시각', width: 'sm' },
          { key: 'status', label: '상태', width: 'sm' },
          { key: 'files', label: '파일', width: 'xs', align: 'end' },
          { key: 'subject', label: '반영 커밋', minWidth: 'md' }
        ]}
        rows={list.map((r) => ({
          key: r.id,
          cells: {
            at: { type: 'relative', at: r.createdAt, format: 'short' },
            status: r.statusLabel + (r.status === 'partial' ? ` ${r.uploaded}/${r.total}` : '') + (r.verifyFailed ? ' · 대조 실패' : ''),
            files: r.total,
            subject: r.subject || r.id
          }
        }))}
      />
      {d && (
        <Card title="run 로그" description={`${d.view.id} · deploy.log`}>
          <Stack gap="sm">
            <CodeView code={d.log.join('\n') || '(비어 있음)'} maxHeight="lg" wrap />
            <Box direction="row" justify="end">
              <Button variant="outline" size="sm" icon="rocket" onPress={() => set(tab, 'deploy')}>
                반영 탭에서 보기
              </Button>
            </Box>
          </Stack>
        </Card>
      )}
    </Stack>
  )
}

function TextField(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  return (
    <Input label={props.label} value={props.value} placeholder={props.placeholder} disabled={props.disabled} onChange={props.onChange} />
  )
}

function TargetsTab() {
  const e = read(editing)
  const list = read(targets)
  return (
    <Stack gap="md">
      <Box direction="row" gap="xs" align="end">
        <Box grow>
          <Select
            label="고칠 대상"
            value={e?.previousId ?? ''}
            placeholder="대상 고르기"
            options={list.map((t) => ({ value: t.id, label: t.label }))}
            onChange={(v) => void editTarget(v)}
          />
        </Box>
        <Button icon="add" variant="outline" onPress={() => editTarget(null)}>
          새 대상
        </Button>
      </Box>
      {e ? <TargetEditor /> : <Text muted>대상을 고르거나 새로 만드세요.</Text>}
    </Stack>
  )
}

function TargetEditor() {
  const e = read(editing)!
  const t = e.draft
  const c = t.connection
  const errors = read(editErrors)
  const notice = read(editNotice)
  const m = read(mapForm)
  const r = read(ruleForm)
  const cc = read(configCheck)
  const ccJob = cc ? read(jobs)[cc.jobId] : null
  return (
    <Stack gap="md">
      {errors.length > 0 && (
        <Callout tone="danger" title="저장하지 않음" icon="error">
          <Stack gap="xs">
            {errors.map((x, i) => (
              <Text key={`v${i}`} size="xs">
                {`· ${x}`}
              </Text>
            ))}
          </Stack>
        </Callout>
      )}
      {notice && <Callout tone="success">{notice}</Callout>}

      <Card title="대상" description="저장소와 run 기록 위치">
        <Stack gap="md">
          <TextField
            label={e.previousId ? '이름 (만든 뒤에는 바꿀 수 없음 — run 기록이 이름에 묶임)' : '이름 (영문 소문자·숫자·_)'}
            value={t.id}
            disabled={!!e.previousId}
            onChange={(v) => patch((x) => ({ ...x, id: v.trim() }))}
          />
          <TextField label="표시 이름" value={t.label} onChange={(v) => patch((x) => ({ ...x, label: v }))} />
          <TextField label="메인 체크아웃" value={t.repo} placeholder="C:/work/repos/my-app" onChange={(v) => patch((x) => ({ ...x, repo: v.trim() }))} />
          <TextField label="main 브랜치" value={t.mainBranch ?? 'main'} onChange={(v) => patch((x) => ({ ...x, mainBranch: v.trim() }))} />
          <TextField label="run 기록 폴더" value={t.runs} placeholder="C:/work/repos/my-app/.local/deploy" onChange={(v) => patch((x) => ({ ...x, runs: v.trim() }))} />
          <TextField
            label="확인용 커밋 (이미 반영된 커밋)"
            value={t.checkCommit ?? ''}
            onChange={(v) => patch((x) => ({ ...x, checkCommit: v.trim() || undefined }))}
          />
          <Switch label="시험용 대상 (자동 선택 안 함)" checked={!!t.test} onChange={(v) => patch((x) => ({ ...x, test: v || undefined }))} />
        </Stack>
      </Card>

      <Card title="연결 (FTP)" description="운영 서버 주소와 운영 루트">
        <Stack gap="md">
          <Box direction="row" gap="xs">
            <Box grow>
              <TextField label="호스트" value={c.host} onChange={(v) => patch((x) => ({ ...x, connection: { ...x.connection, host: v.trim() } }))} />
            </Box>
            <Box width={88} shrink={false}>
              <TextField
                label="포트"
                value={String(c.port ?? 21)}
                onChange={(v) => patch((x) => ({ ...x, connection: { ...x.connection, port: Number(v) || 21 } }))}
              />
            </Box>
          </Box>
          <TextField label="운영 루트" value={c.root} placeholder="/webapps/ROOT" onChange={(v) => patch((x) => ({ ...x, connection: { ...x.connection, root: v.trim() } }))} />
          <Switch
            label="패시브 모드"
            checked={c.passive !== false}
            onChange={(v) => patch((x) => ({ ...x, connection: { ...x.connection, passive: v } }))}
          />
        </Stack>
      </Card>

      {e.previousId && (
        <Card title="접속 정보" description={`Windows 자격 증명 관리자 prod-deploy:${e.previousId}`}>
          <Stack gap="sm">
            <Text size="xs" muted>
              {e.credUser
                ? `저장돼 있음 (사용자 ${e.credUser})`
                : e.netrc
                  ? '자격 증명 관리자에 없음 — 지금은 옮기는 동안의 netrc 로 접속'
                  : '없음 — 저장해야 접속할 수 있음'}
            </Text>
            <Box columns={2} gap="xs">
              <Input label="사용자" value={read(cred).user} onChange={(v) => set(cred, { ...read(cred), user: v })} />
              <Input label="비밀번호" type="password" value={read(cred).password} onChange={(v) => set(cred, { ...read(cred), password: v })} />
            </Box>
            <Box direction="row" justify="end">
              <Button icon="check" size="sm" disabled={!read(cred).user.trim() || !read(cred).password} onPress={saveCred}>
                접속 정보 저장
              </Button>
            </Box>
          </Stack>
        </Card>
      )}

      <Card title="경로 매핑" description="저장소 폴더 → 운영 루트 아래 폴더. 가장 구체적인 매핑을 씁니다.">
        <Stack gap="sm">
          <Table
            label="경로 매핑"
            selectionMode="single"
            selected={read(mapSel) ? [read(mapSel)!] : []}
            onSelectionChange={({ keys }) => {
              const k = keys[0] ?? null
              set(mapSel, k)
              if (k) set(mapForm, { ...t.mappings[Number(k)] })
            }}
            columns={[
              { key: 'local', label: '로컬 경로' },
              { key: 'remote', label: '운영 경로' }
            ]}
            rows={t.mappings.map((x, i) => ({ key: String(i), cells: { local: x.local, remote: x.remote } }))}
          />
          <Box columns={2} gap="xs">
            <Input label="로컬 경로" value={m.local} placeholder="src/main/webapp" onChange={(v) => set(mapForm, { ...read(mapForm), local: v })} />
            <Input label="운영 경로" value={m.remote} placeholder="/" onChange={(v) => set(mapForm, { ...read(mapForm), remote: v })} />
          </Box>
          <Row gap="xs">
            <Button
              icon="add"
              size="sm"
              disabled={!m.local.trim() || !m.remote.trim()}
              onPress={() => {
                patch((x) => ({ ...x, mappings: [...x.mappings, { local: m.local.trim(), remote: m.remote.trim() }] }))
                set(mapForm, { local: '', remote: '' })
              }}
            >
              추가
            </Button>
            <Button
              icon="edit"
              size="sm"
              variant="outline"
              disabled={read(mapSel) === null}
              onPress={() => {
                const i = Number(read(mapSel))
                patch((x) => ({ ...x, mappings: x.mappings.map((y, j) => (j === i ? { local: m.local.trim(), remote: m.remote.trim() } : y)) }))
              }}
            >
              고치기
            </Button>
            <Button
              icon="delete"
              size="sm"
              variant="outline"
              tone="danger"
              disabled={read(mapSel) === null}
              onPress={() => {
                const i = Number(read(mapSel))
                patch((x) => ({ ...x, mappings: x.mappings.filter((_, j) => j !== i) }))
                set(mapSel, null)
              }}
            >
              삭제
            </Button>
          </Row>
        </Stack>
      </Card>

      <Card title="Java 빌드 출력" description="바뀐 .java → 빌드 결과 .class (+내부 클래스). 결과 폴더도 경로 매핑에 있어야 합니다.">
        <Stack gap="sm">
          <Switch
            label="Java 빌드 출력 사용"
            checked={!!t.java}
            onChange={(v) =>
              patch((x) => ({
                ...x,
                java: v ? (x.java ?? { source: 'src/main/java', output: 'build/classes/java/main', major: 52 }) : undefined
              }))
            }
          />
          {t.java && (
            <Stack gap="md">
              <TextField label="소스 폴더" value={t.java.source} onChange={(v) => patch((x) => ({ ...x, java: { ...x.java!, source: v.trim() } }))} />
              <TextField label="빌드 결과 폴더" value={t.java.output} onChange={(v) => patch((x) => ({ ...x, java: { ...x.java!, output: v.trim() } }))} />
              <TextField
                label="class major 버전 (Java 8 = 52, 11 = 55, 17 = 61)"
                value={String(t.java.major)}
                onChange={(v) => patch((x) => ({ ...x, java: { ...x.java!, major: Number(v) || 0 } }))}
              />
              <Textarea
                label="빌드 명령 (안내용, 메인 체크아웃에서 사람이 실행)"
                rows={3}
                value={t.java.build ?? ''}
                onChange={(v) => patch((x) => ({ ...x, java: { ...x.java!, build: v || undefined } }))}
              />
            </Stack>
          )}
        </Stack>
      </Card>

      <Card title="손 처리 규칙" description="패턴(** 는 폴더를 넘음)에 걸리는 파일은 올리지 않고 이유를 보여 줍니다. 위에서부터 처음 맞는 규칙.">
        <Stack gap="sm">
          <Table
            label="손 처리 규칙"
            selectionMode="single"
            maxHeight="sm"
            selected={read(ruleSel) ? [read(ruleSel)!] : []}
            onSelectionChange={({ keys }) => {
              const k = keys[0] ?? null
              set(ruleSel, k)
              if (k) set(ruleForm, { ...t.manual[Number(k)] })
            }}
            columns={[
              { key: 'pattern', label: '패턴' },
              { key: 'reason', label: '이유' }
            ]}
            rows={t.manual.map((x, i) => ({ key: String(i), cells: { pattern: x.pattern, reason: x.reason } }))}
          />
          <Box columns={2} gap="xs">
            <Input label="패턴" value={r.pattern} placeholder="src/main/resources/**" onChange={(v) => set(ruleForm, { ...read(ruleForm), pattern: v })} />
            <Input label="이유" value={r.reason} onChange={(v) => set(ruleForm, { ...read(ruleForm), reason: v })} />
          </Box>
          <Row gap="xs">
            <Button
              icon="add"
              size="sm"
              disabled={!r.pattern.trim() || !r.reason.trim()}
              onPress={() => {
                patch((x) => ({ ...x, manual: [...x.manual, { pattern: r.pattern.trim(), reason: r.reason.trim() }] }))
                set(ruleForm, { pattern: '', reason: '' })
              }}
            >
              추가
            </Button>
            <Button
              icon="edit"
              size="sm"
              variant="outline"
              disabled={read(ruleSel) === null}
              onPress={() => {
                const i = Number(read(ruleSel))
                patch((x) => ({ ...x, manual: x.manual.map((y, j) => (j === i ? { pattern: r.pattern.trim(), reason: r.reason.trim() } : y)) }))
              }}
            >
              고치기
            </Button>
            <Button
              icon="delete"
              size="sm"
              variant="outline"
              tone="danger"
              disabled={read(ruleSel) === null}
              onPress={() => {
                const i = Number(read(ruleSel))
                patch((x) => ({ ...x, manual: x.manual.filter((_, j) => j !== i) }))
                set(ruleSel, null)
              }}
            >
              삭제
            </Button>
          </Row>
        </Stack>
      </Card>

      <Box direction="row" gap="xs" justify="between" align="center">
        <Button icon="check" onPress={saveEdit}>
          설정 저장
        </Button>
        {e.previousId && (
          <Button icon="delete" variant="ghost" tone="danger" onPress={deleteEdit}>
            대상 삭제
          </Button>
        )}
      </Box>

      {e.previousId && (
        <Card title="설정 확인" description="확인용 커밋으로 plan 을 돌려, 모든 파일이 운영에 이미 반영된 것으로 나오는지 봅니다(운영 읽기만).">
          <Stack gap="sm">
            <Button icon="play" variant="outline" disabled={!t.checkCommit || (!!ccJob && (ccJob.state === 'running' || ccJob.state === 'starting'))} onPress={startConfigCheck}>
              {t.checkCommit ? `설정 확인 (${t.checkCommit})` : '확인용 커밋을 먼저 저장하세요'}
            </Button>
            {ccJob && !cc?.result && <JobProgress job={ccJob} />}
            {cc?.result && (
              <Callout tone={cc.ok ? 'success' : 'danger'} icon={cc.ok ? 'check' : 'error'}>
                <Code block>{cc.result}</Code>
              </Callout>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  )
}

export default function Panel() {
  const err = read(error)
  return (
    <Stack gap="md">
      {err && (
        <Callout tone="danger" icon="error">
          <Row justify="between" align="start" gap="xs">
            <Text size="sm">{err}</Text>
            <IconButton icon="close" label="닫기" size="sm" variant="ghost" onPress={() => set(error, null)} />
          </Row>
        </Callout>
      )}
      <Tabs label="운영 반영" value={read(tab)} onChange={(v) => set(tab, v)}>
        <Tab value="deploy" label="반영" icon="rocket">
          <DeployTab />
        </Tab>
        <Tab value="runs" label="run 기록" icon="activity">
          <RunsTab />
        </Tab>
        <Tab value="targets" label="대상 설정" icon="settings">
          <TargetsTab />
        </Tab>
      </Tabs>
      <Box height={56} />
    </Stack>
  )
}
