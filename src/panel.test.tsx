// 패널: 워커 대신 mock 요청으로. 업로드 버튼(대상 이름·파일 수, 백업 전엔 꺼짐), 대상을 바꾸면 plan 을 버림.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'

const targets = [
  { id: 'myapp', label: 'My App', host: 'ftp.example.com', port: 21, root: '/webapps/ROOT', repo: 'C:/work/repos/my-app', test: false },
  { id: 'test', label: '시험', host: '127.0.0.1', port: 2121, root: '/app', repo: 'C:/work/repos/my-app', test: true }
]

/** extra 의 값이 undefined 인 칸은 응답에서 뺀다(Orca 는 undefined 칸이 든 응답을 거절한다). */
function view(status: string, extra: Record<string, unknown> = {}) {
  return JSON.parse(JSON.stringify(rawView(status, extra)))
}

function rawView(status: string, extra: Record<string, unknown>) {
  return {
    id: 'myapp-20261106-180000-abcdef12',
    target: 'myapp',
    label: 'My App',
    host: 'ftp.example.com',
    root: '/webapps/ROOT',
    status,
    statusLabel: status === 'backedUp' ? '백업됨' : 'plan됨',
    verifyFailed: false,
    createdAt: Date.now(),
    base: 'b',
    tip: 't',
    head: 't',
    subject: 'abcdef1 PR 123',
    pr: { number: 123, title: 'PR 123', url: '', notes: '1. SQL 먼저' },
    rows: [
      { kind: 'M', local: 'src/main/webapp/ui/a.xml', remote: '/webapps/ROOT/ui/a.xml', note: '' },
      { kind: 'A', local: 'build/classes/java/main/A.class', remote: '/webapps/ROOT/WEB-INF/classes/A.class', note: '' }
    ],
    manual: [{ path: 'src/main/webapp/WEB-INF/web.xml', reason: '손으로' }],
    skip: [],
    notes: [],
    errors: [],
    warnings: [],
    code: 'abcdef12',
    hasClass: true,
    uploaded: 0,
    total: 2,
    backupDir: null,
    busy: null,
    configChanged: false,
    staleLock: null,
    port: 21,
    ...extra
  }
}

function host(status: string, started: unknown[], extra: Record<string, unknown> = {}) {
  return mockHost({
    requests: {
      'workspace.detect': { target: 'myapp', candidates: ['myapp'], known: true, name: 'my-app', path: 'C:/work/repos/my-app' },
      'targets.list': targets,
      'jobs.recent': [],
      'runs.list': [],
      'prs.recent': [
        { number: 124, title: 'PR 124', mergedAt: '2026-11-07T01:00:00Z', deploy: null },
        { number: 123, title: 'PR 123', mergedAt: '2026-11-06T09:00:00Z', deploy: 'deployed' }
      ],
      check: { ok: true, items: [{ id: 'merged', ok: true, title: 'PR #123 병합됨', detail: [] }], subject: 'abcdef1 PR 123', tip: 't', pr: null },
      'job.start': (input: unknown) => {
        started.push(input)
        return { jobId: 'j1' }
      },
      'run.get': { view: view(status, extra), log: [] }
    }
  })
}

async function planned(status: string, extra: Record<string, unknown> = {}) {
  const started: unknown[] = []
  const v = await mount(panel, { host: host(status, started, extra) })
  await v.settled()
  await v.press({ label: '#123 PR 123' })
  await v.press({ text: '반영 목록 만들기' })
  await v.post('job.changed', {
    id: 'j1', step: 'plan', target: 'myapp', run: 'myapp-20261106-180000-abcdef12', spec: '#123',
    state: 'done', message: null, progress: null, lines: [], startedAt: Date.now(), endedAt: Date.now(), pid: 1
  })
  return { v, started }
}

test('작업공간 저장소로 대상을 고르고 FTP·운영 루트를 보여 준다', async () => {
  const v = await mount(panel, { host: host('planned', []) })
  assert.equal(v.valueOf({ label: '대상' }), 'myapp')
  assert.ok(v.find({ text: /ftp\.example\.com/ }))
  assert.ok(v.find({ text: /\/webapps\/ROOT/ }))
  assert.deepEqual(v.errors, [])
  await v.unmount()
})

test('plan 뒤: 업로드 버튼에 대상 이름과 파일 수, 백업 전에는 꺼짐', async () => {
  const { v, started } = await planned('planned')
  assert.deepEqual(started[0], { step: 'plan', target: 'myapp', spec: '#123', backup: true })
  const up = v.find({ text: /My App에 2개 업로드$/ })
  assert.ok(up, JSON.stringify(v.summary()))
  assert.equal(up!.disabled, true)
  assert.ok(v.find({ text: /톰캣 재기동/ }))
  assert.ok(v.find({ text: /확인 코드 abcdef12/ }))
  await v.unmount()
})

test('백업 뒤 업로드를 누르면 그 run 과 확인 코드로 업로드를 시작', async () => {
  const { v, started } = await planned('backedUp')
  await v.press({ text: /My App에 2개 업로드$/ })
  assert.deepEqual(started[1], { step: 'upload', target: 'myapp', run: 'myapp-20261106-180000-abcdef12', code: 'abcdef12' })
  await v.unmount()
})

test('Backup 요청에는 undefined 칸이 없다 — Orca 가 "input: Invalid input" 으로 거절함', async () => {
  const { v, started } = await planned('planned')
  await v.press({ text: '백업' })
  assert.deepEqual(started[1], { step: 'backup', target: 'myapp', run: 'myapp-20261106-180000-abcdef12' })
  assert.ok(!Object.values(started[1] as object).includes(undefined))
  await v.unmount()
})

test('반영 목록 만들기: 준비 확인이 실패하면 plan 을 시작하지 않고 할 일을 보여 준다', async () => {
  const started: unknown[] = []
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'workspace.detect': { target: 'myapp', candidates: ['myapp'], known: true, name: 'my-app', path: 'C:/work/repos/my-app' },
        'targets.list': targets,
        'jobs.recent': [],
        'runs.list': [],
        'prs.recent': [{ number: 123, title: 'PR 123', mergedAt: '2026-11-06T09:00:00Z', deploy: null }],
        check: {
          ok: false,
          items: [{ id: 'pulled', ok: false, title: 'main pull 됨', detail: ['origin/main 보다 1커밋 뒤'], fix: 'git -C "C:/work/repos/my-app" pull --ff-only' }],
          subject: null,
          tip: null,
          pr: null
        },
        'job.start': (input: unknown) => {
          started.push(input)
          return { jobId: 'j1' }
        }
      }
    })
  })
  await v.settled()
  await v.press({ label: '#123 PR 123' })
  await v.press({ text: '반영 목록 만들기' })
  assert.deepEqual(started, [])
  assert.ok(v.find({ text: /준비 확인에서 멈춤/ }))
  assert.ok(v.find({ text: /pull --ff-only/ }))
  assert.ok(v.find({ text: '다시 확인' }))
  await v.unmount()
})

test('작업공간으로 못 정하면 시험용 대상은 자동으로 고르지 않는다 (리뷰 #10)', async () => {
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'workspace.detect': { target: null, candidates: [], known: false, name: null, path: null },
        'targets.list': [targets[1]],
        'jobs.recent': [],
        'runs.list': []
      }
    })
  })
  assert.equal(v.valueOf({ label: '대상' }), '')
  assert.ok(v.find({ text: /대상을 직접 고르세요/ }))
  assert.equal(v.find({ text: '반영 목록 만들기' }), null)
  await v.unmount()
})

test('대상을 바꾸면 준비 확인과 plan 을 버린다', async () => {
  const { v } = await planned('backedUp')
  await v.select({ label: '대상' }, 'test')
  assert.equal(v.find({ text: /에 2개 업로드/ }), null)
  assert.equal(v.find({ text: /확인 코드/ }), null)
  assert.ok(v.find({ text: '시험용 대상' }))
  await v.unmount()
})

test('PR 을 누르면 고르기만 하고, 반영 목록 만들기를 눌러야 시작한다', async () => {
  const started: unknown[] = []
  const v = await mount(panel, { host: host('planned', started) })
  await v.settled()
  await v.press({ label: '#124 PR 124' })
  assert.deepEqual(started, [])
  assert.equal(v.valueOf({ label: 'PR 번호 또는 커밋' }), '#124')
  await v.press({ text: '반영 목록 만들기' })
  assert.deepEqual(started[0], { step: 'plan', target: 'myapp', spec: '#124', backup: true })
  await v.unmount()
})

test('초기화: 고른 PR·준비 확인·반영 목록을 비운다', async () => {
  const { v } = await planned('backedUp')
  assert.ok(v.find({ text: /My App에 2개 업로드$/ }))
  await v.press({ text: '초기화' })
  assert.equal(v.find({ text: /My App에 2개 업로드$/ }), null)
  assert.equal(v.find({ text: /준비 확인 통과/ }), null)
  assert.equal(v.valueOf({ label: 'PR 번호 또는 커밋' }), '')
  await v.unmount()
})

test('run 기록: 목록 비우기는 숨기기만 하고, 숨긴 run 은 스위치로 다시 본다', async () => {
  const hides: unknown[] = []
  const run = (id: string, hidden: boolean) => ({
    id, status: 'planned', statusLabel: 'plan됨', verifyFailed: false, total: 1, uploaded: 0, createdAt: Date.now(), subject: id, hidden
  })
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'workspace.detect': { target: 'myapp', candidates: ['myapp'], known: true, name: 'my-app', path: 'C:/work/repos/my-app' },
        'targets.list': targets,
        'jobs.recent': [],
        'prs.recent': [],
        'runs.list': [run('myapp-20261109-100000-aaaaaaa1', false), run('myapp-20261109-090000-aaaaaaa2', true)],
        'runs.hide': (input: unknown) => {
          hides.push(input)
          return { count: 1, kept: 0 }
        }
      }
    })
  })
  await v.settled()
  await v.select({ label: '운영 반영' }, 'runs')
  assert.ok(v.find({ text: '숨긴 run 보기 (1)' }) || v.find({ label: '숨긴 run 보기 (1)' }))
  await v.press({ text: '목록 비우기' })
  assert.deepEqual(hides, [{ target: 'myapp', hidden: true }])
  assert.ok(v.find({ text: /1개 숨김/ }))
  await v.unmount()
})

test('경고는 보여 주기만 하고 업로드를 막지 않는다', async () => {
  const w = ['상수 값이 바뀜: com.x.Foo.LIMIT (1 → 2) — 이 이름이 나오는 소스가 반영 목록에 없음: src/Bar.java']
  const { v, started } = await planned('backedUp', { warnings: w })
  assert.ok(v.find({ text: /경고 1건/ }))
  assert.ok(v.find({ text: /src\/Bar\.java/ }))
  assert.equal(v.find({ text: /My App에 2개 업로드$/ })!.disabled, false)
  await v.press({ text: /My App에 2개 업로드$/ })
  assert.deepEqual(started.at(-1), { step: 'upload', target: 'myapp', run: 'myapp-20261106-180000-abcdef12', code: 'abcdef12' })
  await v.unmount()
})

test('경고 칸이 없는 run(예전 워커)도 그린다', async () => {
  const { v } = await planned('backedUp', { warnings: undefined })
  assert.ok(v.find({ text: /My App에 2개 업로드$/ }))
  assert.deepEqual(v.errors, [])
  await v.unmount()
})

test('설정 확인: 저장하지 않은 변경이 있으면 막고, 앞의 확인 결과는 보여 주지 않는다', async () => {
  const saved = {
    id: 'myapp',
    label: 'My App',
    repo: 'C:/work/repos/my-app',
    mainBranch: 'main',
    runs: 'C:/work/repos/my-app/.local/deploy',
    connection: { protocol: 'ftp', host: 'ftp.example.com', port: 21, root: '/webapps/ROOT', passive: true },
    mappings: [{ local: 'src/main/webapp', remote: '/' }],
    manual: [],
    checkCommit: 'abc1234'
  }
  const started: unknown[] = []
  const saves: unknown[] = []
  const done = view('blocked', {
    errors: ['운영본이 이미 반영 커밋 내용과 같음(이미 반영됨?): /webapps/ROOT/ui/a.xml'],
    rows: [{ kind: 'M', local: 'src/main/webapp/ui/a.xml', remote: '/webapps/ROOT/ui/a.xml', note: '' }],
    code: null
  })
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'workspace.detect': { target: 'myapp', candidates: ['myapp'], known: true, name: 'my-app', path: 'C:/work/repos/my-app' },
        'targets.list': targets,
        'jobs.recent': [],
        'runs.list': [],
        'prs.recent': [],
        'target.get': { target: saved, credUser: 'ftpuser', netrc: false },
        'target.save': (input: unknown) => {
          saves.push(input)
          return { errors: [] }
        },
        'job.start': (input: unknown) => {
          started.push(input)
          return { jobId: 'j1' }
        },
        'run.get': { view: done, log: [] }
      }
    })
  })
  await v.settled()
  await v.select({ label: '운영 반영' }, 'targets')
  await v.select({ label: '고칠 대상' }, 'myapp')

  // 저장된 그대로면 확인할 수 있다
  await v.press({ text: '설정 확인 (abc1234)' })
  assert.deepEqual(started[0], { step: 'plan', target: 'myapp', spec: 'abc1234', purpose: 'configCheck' })
  await v.post('job.changed', {
    id: 'j1', step: 'plan', target: 'myapp', run: 'myapp-20261106-180000-abcdef12', spec: 'abc1234',
    state: 'done', message: null, progress: null, lines: [], startedAt: Date.now(), endedAt: Date.now(), pid: 1
  })
  assert.ok(v.find({ text: /맞음: 1개 파일/ }), JSON.stringify(v.summary()))

  // 칸을 고치면: 앞의 "맞음" 은 사라지고, 저장 전에는 확인을 누를 수 없다
  await v.type({ label: '운영 루트' }, '/webapps/OTHER', { replace: true })
  assert.equal(v.find({ text: /맞음: 1개 파일/ }), null)
  const blocked = v.find({ text: /저장하지 않은 변경이 있음 — 설정 저장 후 확인/ })
  assert.ok(blocked, JSON.stringify(v.summary()))
  assert.equal(blocked!.disabled, true)
  assert.equal(started.length, 1)

  // 저장하면 다시 확인할 수 있지만, 옛 설정의 결과는 돌아오지 않는다
  await v.press({ text: '설정 저장' })
  assert.equal((saves[0] as { target: { connection: { root: string } } }).target.connection.root, '/webapps/OTHER')
  assert.equal(v.find({ text: '설정 확인 (abc1234)' })!.disabled, false)
  assert.equal(v.find({ text: /맞음: 1개 파일/ }), null)
  assert.ok(v.find({ text: /앞의 확인 결과는 보여 주지 않습니다/ }))
  await v.unmount()
})

// ── 대상 설정: 응답이 늦게 오거나 순서가 바뀌는 경우 ──
// 대기 중인 요청이 있으면 동작(press 등)이 끝나지 않는다. 그래서 동작을 걸어만 두고, 요청이 워커에 닿았는지(gate.entered)와
// 화면이 바뀌었는지(until)를 기다려 순서를 맞춘다.

/** 응답 순서를 잘못 맞춘 시험이 끝없이 기다리지 않게 한다. */
const slow = { timeout: 15000 }

/** 워커가 요청을 받았지만 아직 답하지 않은 상태를 만든다. */
function gate<T>() {
  let resolve!: (value: T) => void
  let enter!: () => void
  const promise = new Promise<T>((r) => (resolve = r))
  const entered = new Promise<void>((r) => (enter = r))
  return {
    entered,
    resolve,
    handler: () => {
      enter()
      return promise
    }
  }
}

/** 조건이 맞을 때까지 기다린다(느린 환경에서도 순서가 흔들리지 않게). */
async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`기다리다 그만둠: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const targetA = {
  id: 'myapp',
  label: 'My App',
  repo: 'C:/work/repos/my-app',
  mainBranch: 'main',
  runs: 'C:/work/repos/my-app/.local/deploy',
  connection: { protocol: 'ftp', host: 'ftp.example.com', port: 21, root: '/webapps/ROOT', passive: true },
  mappings: [{ local: 'src/main/webapp', remote: '/' }],
  manual: [],
  checkCommit: 'abc1234'
}
const targetB = { ...targetA, id: 'test', label: '시험', test: true, checkCommit: 'def5678', connection: { ...targetA.connection, host: '127.0.0.1', port: 2121, root: '/app' } }
const detail = (id: string) => ({ target: id === 'test' ? targetB : targetA, credUser: 'ftpuser', netrc: false })
const checkedView = () =>
  view('blocked', {
    errors: ['운영본이 이미 반영 커밋 내용과 같음(이미 반영됨?): /webapps/ROOT/ui/a.xml'],
    rows: [{ kind: 'M', local: 'src/main/webapp/ui/a.xml', remote: '/webapps/ROOT/ui/a.xml', note: '' }],
    code: null
  })
const doneJob = (id: string) => ({
  id,
  step: 'plan',
  target: 'myapp',
  run: 'myapp-20261106-180000-abcdef12',
  spec: 'abc1234',
  state: 'done',
  message: null,
  progress: null,
  lines: [],
  startedAt: Date.now(),
  endedAt: Date.now(),
  pid: 1
})

async function editor(over: Record<string, unknown>) {
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'workspace.detect': { target: 'myapp', candidates: ['myapp'], known: true, name: 'my-app', path: 'C:/work/repos/my-app' },
        'targets.list': targets,
        'jobs.recent': [],
        'runs.list': [],
        'prs.recent': [],
        'target.get': (input: { id: string }) => detail(input.id),
        'target.save': { errors: [] },
        ...over
      }
    })
  })
  await v.settled()
  await v.select({ label: '운영 반영' }, 'targets')
  await v.select({ label: '고칠 대상' }, 'myapp')
  return v
}

test('늦게 온 저장 응답은 그 사이 연 다른 대상의 편집 상태를 덮지 않는다', slow, async () => {
  const save = gate<{ errors: string[] }>()
  const v = await editor({ 'target.save': save.handler })
  await v.type({ label: '표시 이름' }, 'My App 2', { replace: true })
  const saving = v.press({ text: '설정 저장' })
  await save.entered
  const switching = v.select({ label: '고칠 대상' }, 'test')
  await until(() => v.find({ text: '설정 확인 (def5678)' }) !== null, '시험 대상 편집기')
  save.resolve({ errors: [] })
  await Promise.all([saving, switching])
  await v.settled()
  assert.equal(v.valueOf({ label: '고칠 대상' }), 'test')
  assert.equal(v.valueOf({ label: '표시 이름' }), '시험')
  // 다른 대상의 저장본이 붙으면 "저장하지 않은 변경"으로 보여 확인 버튼이 막힌다
  const check = v.find({ text: '설정 확인 (def5678)' })
  assert.ok(check, JSON.stringify(v.summary()))
  assert.equal(check!.disabled, false)
  await v.unmount()
})

test('대상을 바꾸면 불러오는 중에도 앞 대상의 응답은 받지 않는다', slow, async () => {
  const start = gate<{ jobId: string }>()
  const load = gate<unknown>()
  let gets = 0
  const v = await editor({
    'job.start': start.handler,
    // 처음(myapp)은 바로, 바꿀 때(test)는 늦게 답한다
    'target.get': (input: { id: string }) => (gets++ === 0 ? detail(input.id) : load.handler()),
    'run.get': { view: checkedView(), log: [] }
  })
  // A 의 설정 확인을 시작(응답 대기) → B 로 바꿈(불러오기 대기) → A 의 시작 응답 → B 불러오기 응답
  const checking = v.press({ text: '설정 확인 (abc1234)' })
  await start.entered
  const switching = v.select({ label: '고칠 대상' }, 'test')
  await load.entered
  start.resolve({ jobId: 'j1' })
  // 시작 응답이 패널에 닿을 틈을 준다(불러오기가 대기 중이라 press 가 끝나기를 기다릴 수는 없다). 이 틈이 모자라도
  // 시험이 흔들리지는 않는다: 그때는 "B 를 연 뒤에 온 A 의 응답"이 되고, 그것도 받지 않아야 한다.
  await new Promise((r) => setTimeout(r, 50))
  load.resolve(detail('test'))
  await Promise.all([checking, switching])
  // A 의 작업이 끝났다는 소식이 와도 B 편집기에는 아무것도 붙지 않는다
  await v.post('job.changed', doneJob('j1'))
  await v.settled()
  assert.equal(v.valueOf({ label: '표시 이름' }), '시험')
  assert.equal(v.find({ text: /앞의 확인 결과는 보여 주지 않습니다/ }), null, JSON.stringify(v.summary()))
  assert.equal(v.find({ text: /맞음: 1개 파일/ }), null)
  assert.equal(v.find({ text: '설정 확인 (def5678)' })!.disabled, false)
  await v.unmount()
})

test('대상을 불러오는 동안에는 앞 대상의 편집기를 보여 주지 않는다', slow, async () => {
  const load = gate<unknown>()
  let gets = 0
  const v = await editor({ 'target.get': (input: { id: string }) => (gets++ === 0 ? detail(input.id) : load.handler()) })
  const switching = v.select({ label: '고칠 대상' }, 'test')
  await load.entered
  await until(() => v.find({ text: '설정 저장' }) === null, '앞 대상의 편집기가 닫힘')
  assert.equal(v.valueOf({ label: '고칠 대상' }), 'test')
  load.resolve(detail('test'))
  await switching
  assert.equal(v.valueOf({ label: '표시 이름' }), '시험')
  await v.unmount()
})

test('저장 요청이 가는 동안에는 저장·삭제를 누를 수 없고, 답이 오면 풀린다', slow, async () => {
  const save = gate<{ errors: string[] }>()
  const v = await editor({ 'target.save': save.handler })
  await v.type({ label: '표시 이름' }, 'My App 2', { replace: true })
  const saving = v.press({ text: '설정 저장' })
  await save.entered
  await until(() => v.find({ text: '설정 저장' })!.disabled === true, '저장 버튼 잠김')
  assert.equal(v.find({ text: '대상 삭제' })!.disabled, true)
  save.resolve({ errors: [] })
  await saving
  await v.settled()
  assert.equal(v.find({ text: '설정 저장' })!.disabled, false)
  assert.ok(v.find({ text: '저장함' }))
  await v.unmount()
})

test('저장이 거절되면(잘못된 설정) 고친 칸과 저장 안 된 상태가 그대로 남고 버튼은 풀린다', slow, async () => {
  const v = await editor({ 'target.save': { errors: ['운영 루트가 잘못됨'] } })
  await v.type({ label: '운영 루트' }, 'webapps', { replace: true })
  await v.press({ text: '설정 저장' })
  assert.ok(v.find({ text: /운영 루트가 잘못됨/ }), JSON.stringify(v.summary()))
  assert.equal(v.valueOf({ label: '운영 루트' }), 'webapps')
  assert.equal(v.find({ text: '설정 저장' })!.disabled, false)
  assert.ok(v.find({ text: /저장하지 않은 변경이 있음 — 설정 저장 후 확인/ }))
  assert.equal(v.find({ text: '저장함' }), null)
  await v.unmount()
})

test('늦게 온 접속 정보 응답은 그 사이 고친 칸을 되돌리지 않는다', slow, async () => {
  const creds = gate<{ user: string }>()
  const v = await editor({ 'creds.set': creds.handler })
  await v.type({ label: '비밀번호' }, 'pw')
  const saving = v.press({ text: '접속 정보 저장' })
  await creds.entered
  // type 은 여러 걸음이라 응답을 기다리게 된다. 한 번에 끝나는 스위치로 칸을 고친다.
  const editing = v.toggle({ label: '패시브 모드' })
  await until(() => v.valueOf({ label: '패시브 모드' }) === false, '패시브 모드 끔')
  creds.resolve({ user: 'ftpuser' })
  await Promise.all([saving, editing])
  await v.settled()
  assert.equal(v.valueOf({ label: '패시브 모드' }), false, '기다리는 사이 고친 칸이 그대로 남아야 한다')
  assert.ok(v.find({ text: /저장하지 않은 변경이 있음 — 설정 저장 후 확인/ }), JSON.stringify(v.summary()))
  await v.unmount()
})

test('옛 설정 확인의 결과가 늦게 와도 새로 시작한 확인을 덮지 않는다', slow, async () => {
  const first = gate<{ view: unknown; log: string[] }>()
  let gets = 0
  let jobsStarted = 0
  const v = await editor({
    'job.start': () => ({ jobId: `j${++jobsStarted}` }),
    'run.get': () => (gets++ === 0 ? first.handler() : { view: checkedView(), log: [] })
  })
  await v.press({ text: '설정 확인 (abc1234)' })
  const finishing = v.post('job.changed', doneJob('j1'))
  await first.entered
  // j1 의 결과를 받기 전에 확인을 다시 시작한다
  const again = v.press({ text: '설정 확인 (abc1234)' })
  await until(() => jobsStarted === 2, '두 번째 확인 시작')
  first.resolve({ view: checkedView(), log: [] })
  await Promise.all([finishing, again])
  await v.settled()
  assert.equal(v.find({ text: /맞음: 1개 파일/ }), null, '옛 작업(j1)의 결과가 새 확인(j2) 자리에 보이면 안 된다')
  await v.unmount()
})

test('대상을 지우지 못하면 편집기를 닫지 않는다 — 저장하지 않은 변경이 사라지지 않게', slow, async () => {
  const v = await editor({
    'target.delete': () => {
      throw new Error('지우지 못함')
    }
  })
  await v.toggle({ label: '패시브 모드' })
  await v.press({ text: '대상 삭제' })
  assert.equal(v.valueOf({ label: '패시브 모드' }), false, JSON.stringify(v.summary()))
  assert.equal(v.find({ text: '설정 저장' })!.disabled, false)
  assert.equal(v.find({ text: /대상을 고르거나 새로 만드세요/ }), null)
  await v.unmount()
})

// ── 대상 설정: 가져오기·내보내기 ──

test('받은 설정 가져오기: 붙여 넣은 글자를 새 대상으로 열고, 저장은 사람이 누를 때만 한다', slow, async () => {
  const imports: unknown[] = []
  const saves: { target: { id: string; repo: string }; previousId: string | null }[] = []
  const draft = { ...targetA, id: 'newapp', label: 'New App', repo: 'C:/work/repos/new-app', runs: 'C:/Users/me/.prod-deploy/runs/newapp' }
  const v = await editor({
    'target.import': (input: unknown) => {
      imports.push(input)
      return { errors: [], draft, notes: ['메인 체크아웃에 지금 작업공간의 저장소(C:/work/repos/new-app)를 넣었습니다. 이 대상의 저장소가 맞는지 확인하세요.'] }
    },
    'target.save': (input: { target: { id: string; repo: string }; previousId: string | null }) => {
      saves.push(input)
      return { errors: [] }
    }
  })
  await v.press({ text: '받은 설정 가져오기' })
  assert.equal(v.find({ text: '불러오기' })!.disabled, true, '글자를 넣기 전에는 누를 수 없다')
  await v.type({ label: '받은 글자' }, '{"format":"orca-prod-deploy-target"}')
  await v.press({ text: '불러오기' })
  assert.deepEqual(imports, [{ text: '{"format":"orca-prod-deploy-target"}' }])
  // 새 대상으로 열렸고(이름을 고칠 수 있음), 아직 저장되지 않았다
  assert.equal(v.valueOf({ label: '이름 (영문 소문자·숫자·_)' }), 'newapp')
  assert.equal(v.valueOf({ label: '메인 체크아웃' }), 'C:/work/repos/new-app')
  assert.ok(v.find({ text: /지금 작업공간의 저장소/ }), JSON.stringify(v.summary()))
  assert.ok(v.find({ text: /① 메인 체크아웃 확인/ }))
  assert.equal(saves.length, 0)
  await v.press({ text: '설정 저장' })
  assert.equal(saves.length, 1)
  assert.equal(saves[0].previousId, null, '새 대상으로 저장한다(있는 대상을 덮어쓰지 않음)')
  assert.equal(saves[0].target.id, 'newapp')
  assert.ok(v.find({ text: /저장함 — 다음: 아래 접속 정보/ }), JSON.stringify(v.summary()))
  assert.equal(v.find({ text: /① 메인 체크아웃 확인/ }), null, '저장한 뒤에는 "아직 저장 전" 안내를 내린다')
  await v.unmount()
})

test('받은 설정 가져오기: 글자가 틀리면 이유를 보여 주고 편집기를 열지 않는다', slow, async () => {
  const v = await editor({ 'target.import': { errors: ['알 수 없는 항목: repo2'], draft: null, notes: [] } })
  await v.press({ text: '받은 설정 가져오기' })
  await v.type({ label: '받은 글자' }, '{"x":1}')
  await v.press({ text: '불러오기' })
  assert.ok(v.find({ text: /알 수 없는 항목: repo2/ }), JSON.stringify(v.summary()))
  assert.equal(v.valueOf({ label: '받은 글자' }), '{"x":1}', '붙여 넣은 글자는 그대로 둔다')
  assert.equal(v.find({ text: '설정 저장' }), null)
  // 취소하면 가져오기 전의 편집기로 돌아간다
  await v.press({ text: '취소' })
  assert.equal(v.valueOf({ label: '표시 이름' }), 'My App')
  await v.unmount()
})

test('내보내기: 저장된 설정만 내보내고, 칸을 고치면 내보낸 글자를 지운다', slow, async () => {
  const exports: unknown[] = []
  const v = await editor({
    'target.export': (input: unknown) => {
      exports.push(input)
      return { text: '{\n  "format": "orca-prod-deploy-target"\n}' }
    }
  })
  await v.press({ text: '내보내기' })
  assert.deepEqual(exports, [{ id: 'myapp' }])
  assert.equal(v.valueOf({ label: /내보낸 글자/ }), '{\n  "format": "orca-prod-deploy-target"\n}')
  assert.ok(v.find({ text: /사내 채널로만 전달/ }))
  // 칸을 고치면 화면의 설정과 내보낸 글자가 달라지므로 지우고, 저장 전에는 내보낼 수 없다
  await v.toggle({ label: '패시브 모드' })
  assert.equal(v.find({ label: /내보낸 글자/ }), null)
  const blocked = v.find({ text: /저장하지 않은 변경이 있음 — 설정 저장 후 내보내기/ })
  assert.ok(blocked, JSON.stringify(v.summary()))
  assert.equal(blocked!.disabled, true)
  await v.unmount()
})

test('가져오기를 닫고 다시 열면, 앞 요청의 늦은 응답은 받지 않는다', slow, async () => {
  const first = gate<unknown>()
  const draft = { ...targetA, id: 'newapp', label: 'New App' }
  const v = await editor({ 'target.import': first.handler })
  await v.press({ text: '받은 설정 가져오기' })
  await v.type({ label: '받은 글자' }, 'AAA')
  const loading = v.press({ text: '불러오기' })
  await first.entered
  // 요청이 가는 동안에는 글자 칸이 잠긴다(보낸 글자와 화면의 글자가 달라지지 않게)
  await until(() => v.find({ label: '받은 글자' })?.disabled === true, '글자 칸 잠김')
  // 닫고 다시 연다: 새 가져오기다
  const closing = v.press({ text: '취소' })
  await until(() => v.find({ label: '받은 글자' }) === null, '가져오기 닫힘')
  const reopening = v.press({ text: '받은 설정 가져오기' })
  await until(() => v.find({ label: '받은 글자' }) !== null, '가져오기 다시 열림')
  first.resolve({ errors: [], draft, notes: ['앞 요청의 안내'] })
  await Promise.all([loading, closing, reopening])
  await v.settled()
  // 앞 요청(AAA)의 초안이 열리면 안 되고, 새로 연 빈 가져오기 칸이 그대로 있어야 한다
  assert.ok(v.find({ label: '받은 글자' }), JSON.stringify(v.summary()))
  assert.equal(v.valueOf({ label: '받은 글자' }), '')
  assert.equal(v.find({ text: /앞 요청의 안내/ }), null)
  assert.equal(v.find({ text: /아직 저장 전/ }), null)
  await v.unmount()
})
