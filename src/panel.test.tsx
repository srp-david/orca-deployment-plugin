// 패널: 워커 대신 mock 요청으로. 업로드 버튼(대상 이름·파일 수, 백업 전엔 꺼짐), 대상을 바꾸면 plan 을 버림.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'

const targets = [
  { id: 'myapp', label: 'My App', host: 'ftp.example.com', port: 21, root: '/webapps/ROOT', repo: 'C:/work/repos/my-app', test: false },
  { id: 'test', label: '시험', host: '127.0.0.1', port: 2121, root: '/app', repo: 'C:/work/repos/my-app', test: true }
]

function view(status: string) {
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
    code: 'abcdef12',
    hasClass: true,
    uploaded: 0,
    total: 2,
    backupDir: null,
    busy: null,
    configChanged: false,
    staleLock: null,
    port: 21
  }
}

function host(status: string, started: unknown[]) {
  return mockHost({
    requests: {
      'workspace.detect': { target: 'myapp', candidates: ['myapp'], known: true, name: 'my-app', path: 'C:/work/repos/my-app' },
      'targets.list': targets,
      'jobs.recent': [],
      'runs.list': [],
      check: { ok: true, items: [{ id: 'merged', ok: true, title: 'PR #123 병합됨', detail: [] }], subject: 'abcdef1 PR 123', tip: 't', pr: null },
      'job.start': (input: unknown) => {
        started.push(input)
        return { jobId: 'j1' }
      },
      'run.get': { view: view(status), log: [] }
    }
  })
}

async function planned(status: string) {
  const started: unknown[] = []
  const v = await mount(panel, { host: host(status, started) })
  await v.type({ label: 'PR 번호 또는 커밋' }, '#123')
  await v.press({ text: '준비 확인' })
  await v.press({ text: 'Plan' })
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
  assert.deepEqual(started[0], { step: 'plan', target: 'myapp', spec: '#123' })
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
  assert.equal(v.find({ text: '준비 확인' }), null)
  await v.unmount()
})

test('대상을 바꾸면 준비 확인과 plan 을 버린다', async () => {
  const { v } = await planned('backedUp')
  await v.select({ label: '대상' }, 'test')
  assert.equal(v.find({ text: /에 2개 업로드/ }), null)
  assert.equal(v.find({ text: 'Plan' }), null)
  assert.ok(v.find({ text: '시험용 대상' }))
  await v.unmount()
})
