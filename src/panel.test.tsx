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

/** 응답을 기다리는 동안에는 동작(press 등)이 끝나지 않는다. 기다리지 않고 걸어 둔 뒤, 화면이 반응할 틈만 준다. */
const tick = () => new Promise((r) => setTimeout(r, 20))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
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
const checkedView = () =>
  view('blocked', {
    errors: ['운영본이 이미 반영 커밋 내용과 같음(이미 반영됨?): /webapps/ROOT/ui/a.xml'],
    rows: [{ kind: 'M', local: 'src/main/webapp/ui/a.xml', remote: '/webapps/ROOT/ui/a.xml', note: '' }],
    code: null
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
        'target.get': (input: { id: string }) => ({ target: input.id === 'test' ? targetB : targetA, credUser: 'ftpuser', netrc: false }),
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

test('늦게 온 저장 응답은 그 사이 연 다른 대상의 편집 상태를 덮지 않는다', async () => {
  const save = deferred<{ errors: string[] }>()
  const v = await editor({ 'target.save': () => save.promise })
  await v.type({ label: '표시 이름' }, 'My App 2', { replace: true })
  const saving = v.press({ text: '설정 저장' })
  await tick()
  const switching = v.select({ label: '고칠 대상' }, 'test')
  await tick()
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

test('저장 요청이 가는 동안에는 저장을 다시 누를 수 없다', async () => {
  const save = deferred<{ errors: string[] }>()
  const v = await editor({ 'target.save': () => save.promise })
  await v.type({ label: '표시 이름' }, 'My App 2', { replace: true })
  const saving = v.press({ text: '설정 저장' })
  await tick()
  assert.equal(v.find({ text: '설정 저장' })!.disabled, true)
  save.resolve({ errors: [] })
  await saving
  await v.settled()
  assert.equal(v.find({ text: '설정 저장' })!.disabled, false)
  await v.unmount()
})

test('늦게 온 접속 정보 응답은 그 사이 고친 칸을 되돌리지 않는다', async () => {
  const creds = deferred<{ user: string }>()
  const v = await editor({ 'creds.set': () => creds.promise })
  await v.type({ label: '비밀번호' }, 'pw')
  const saving = v.press({ text: '접속 정보 저장' })
  await tick()
  // type 은 여러 걸음이라 응답을 기다리게 된다. 한 번에 끝나는 스위치로 칸을 고친다.
  const editing = v.toggle({ label: '패시브 모드' })
  await tick()
  assert.equal(v.valueOf({ label: '패시브 모드' }), false)
  creds.resolve({ user: 'ftpuser' })
  await Promise.all([saving, editing])
  await v.settled()
  assert.equal(v.valueOf({ label: '패시브 모드' }), false, '기다리는 사이 고친 칸이 그대로 남아야 한다')
  assert.ok(v.find({ text: /저장하지 않은 변경이 있음 — 설정 저장 후 확인/ }), JSON.stringify(v.summary()))
  await v.unmount()
})

test('옛 설정 확인의 결과가 늦게 와도 새로 시작한 확인을 덮지 않는다', async () => {
  const first = deferred<{ view: unknown; log: string[] }>()
  let gets = 0
  let jobsStarted = 0
  const v = await editor({
    'job.start': () => ({ jobId: `j${++jobsStarted}` }),
    'run.get': () => (gets++ === 0 ? first.promise : { view: checkedView(), log: [] })
  })
  await v.press({ text: '설정 확인 (abc1234)' })
  const finishing = v.post('job.changed', {
    id: 'j1', step: 'plan', target: 'myapp', run: 'myapp-20261106-180000-abcdef12', spec: 'abc1234',
    state: 'done', message: null, progress: null, lines: [], startedAt: Date.now(), endedAt: Date.now(), pid: 1
  })
  await tick()
  // j1 의 결과를 받기 전에 확인을 다시 시작한다
  const again = v.press({ text: '설정 확인 (abc1234)' })
  await tick()
  assert.equal(jobsStarted, 2)
  first.resolve({ view: checkedView(), log: [] })
  await Promise.all([finishing, again])
  await v.settled()
  assert.equal(v.find({ text: /맞음: 1개 파일/ }), null, '옛 작업(j1)의 결과가 새 확인(j2) 자리에 보이면 안 된다')
  await v.unmount()
})
