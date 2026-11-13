// 워커 핸들러를 mock host 로: 대상 설정 저장·검사, 작업공간으로 대상 찾기, 잘못된 요청 거절.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker.ts'

const home = mkdtempSync(join(tmpdir(), 'pd-worker-')).replace(/\\/g, '/')
process.env.PRODDEPLOY_HOME = `${home}/home`
const repo = `${home}/repo`
mkdirSync(repo, { recursive: true })
spawnSync('git', ['init', '-q', '-b', 'main', repo])

const target = {
  id: 'fx',
  label: 'FX',
  repo,
  runs: `${home}/runs`,
  connection: { protocol: 'ftp' as const, host: '127.0.0.1', port: 2121, root: '/app' },
  mappings: [{ local: 'src/main/webapp', remote: '/' }],
  manual: []
}

function host(workspaces: { name: string; branch: string; path: string }[]) {
  return mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'repo', terminals: [] },
      'workspace.list': {
        workspaces: workspaces.map((w, i) => ({ id: `w${i}`, kind: 'folder', hostId: null, ...w })),
        truncated: false
      },
      'statusBar.update': { ok: true },
      'commands.run': { ran: true }
    }
  })
}

test('대상 설정: 잘못된 설정은 저장하지 않고 이유를 돌려준다', async () => {
  const worker = await mountWorker(main, { host: host([]) })
  const bad = await worker.request('target.save', { target: { ...target, id: 'f-x' }, previousId: null })
  assert.ok(bad.errors.some((e: string) => e.includes('- 는')))
  assert.deepEqual(await worker.request('targets.list'), [])
  const ok = await worker.request('target.save', { target, previousId: null })
  assert.deepEqual(ok.errors, [])
  const list = await worker.request('targets.list')
  assert.equal(list.length, 1)
  assert.equal(list[0].root, '/app')
  await worker.deactivate()
})

test('대상 이름은 바꿀 수 없다 — 이미 올린 run 을 되돌릴 길이 끊기므로 (리뷰 #9)', async () => {
  const worker = await mountWorker(main, { host: host([]) })
  const r = await worker.request('target.save', { target: { ...target, id: 'fy' }, previousId: 'fx' })
  assert.ok(r.errors.some((e: string) => e.includes('바꿀 수 없음')))
  assert.deepEqual((await worker.request('targets.list')).map((t: { id: string }) => t.id), ['fx'])
  await worker.deactivate()
})

test('작업공간 저장소로 대상을 고른다 — 이름·브랜치가 하나와 맞을 때만', async () => {
  writeFileSync(`${home}/home/targets/fx.json`, JSON.stringify(target))
  const one = await mountWorker(main, { host: host([{ name: 'repo', branch: 'main', path: repo }]) })
  const ws = await one.request('workspace.detect')
  assert.equal(ws.target, 'fx')
  assert.equal(ws.known, true)
  await one.deactivate()

  const two = await mountWorker(main, {
    host: host([
      { name: 'repo', branch: 'main', path: repo },
      { name: 'repo', branch: 'main', path: `${home}/other` }
    ])
  })
  const unknown = await two.request('workspace.detect')
  assert.equal(unknown.target, null)
  assert.equal(unknown.known, false)
  await two.deactivate()
})

test('준비 확인 응답은 JSON 값만 담는다 — undefined 칸이 있으면 Orca 가 응답을 거절함', async () => {
  writeFileSync(`${home}/home/targets/fx.json`, JSON.stringify(target))
  mkdirSync(`${repo}/src/main/webapp`, { recursive: true })
  writeFileSync(`${repo}/src/main/webapp/a.xml`, '<a/>')
  const g = (...args: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  g('add', '-A')
  g('commit', '-q', '-m', 'one')
  writeFileSync(`${repo}/src/main/webapp/a.xml`, '<b/>')
  g('commit', '-qam', 'two')
  const worker = await mountWorker(main, { host: host([]) })
  const r = await worker.request('check', { target: 'fx', spec: 'HEAD' })
  const json = (v: unknown, path: string): void => {
    assert.notEqual(v, undefined, `undefined: ${path}`)
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) json(x, `${path}.${k}`)
  }
  json(r, '$')
  assert.ok(r.items.some((i: { id: string }) => i.id === 'branch'))
  await worker.deactivate()
})

test('작업 시작: 다른 대상의 run 이나 확인 코드 없는 업로드는 거절', async () => {
  const worker = await mountWorker(main, { host: host([]) })
  let refused = ''
  try {
    await worker.request('job.start', { step: 'upload', target: 'fx', run: 'zz-20260101-000000-00000000', code: 'x' })
  } catch (e) {
    refused = String((e as Error).message)
  }
  assert.ok(refused.length > 0)
  try {
    await worker.request('job.start', { step: 'plan', target: 'fx' })
    assert.fail('spec 없이 plan 이 시작됨')
  } catch (e) {
    assert.match(String((e as Error).message), /PR 번호 또는 커밋/)
  }
  await worker.deactivate()
})

test('작업 시작: 메인 체크아웃 폴더가 없으면 CLI 를 띄우지 않고 그 경로를 알려 준다', async () => {
  const missing = { ...target, id: 'nofolder', repo: `${home}/no-such-repo` }
  writeFileSync(`${home}/home/targets/nofolder.json`, JSON.stringify(missing))
  const worker = await mountWorker(main, { host: host([]) })
  try {
    await worker.request('job.start', { step: 'plan', target: 'nofolder', spec: '#1' })
    assert.fail('폴더가 없는데 작업이 시작됨')
  } catch (e) {
    assert.match(String((e as Error).message), /메인 체크아웃이 없음: .*no-such-repo/)
  }
  await worker.deactivate()
})

test('상태 표시줄 명령: 패널이 보이면 오른쪽 사이드바를 닫는다', async () => {
  const h = host([])
  const worker = await mountWorker(main, { host: h })
  await worker.request('panel.visible', { visible: true })
  await worker.command('openPanel')
  assert.deepEqual(h.callsOf('commands.run'), [{ action: 'sidebar.right.toggle' }])
  assert.deepEqual(h.refusals, [])
  await worker.deactivate()
})

test('상태 표시줄 초기화: 도는 작업이 없으면 처음 모양(운영 반영)으로', async () => {
  const h = host([])
  const worker = await mountWorker(main, { host: h })
  await worker.request('status.reset')
  const last = h.callsOf('statusBar.update').at(-1) as { id: string; text: string; icon: string; tone: string }
  assert.deepEqual(last, { id: 'deploy', text: '운영 반영', icon: 'rocket', tone: 'neutral' })
  await worker.deactivate()
})

test('대상 내보내기·가져오기: 개인 경로는 빼고, 받는 쪽은 지금 작업공간의 저장소를 제안한다', async () => {
  writeFileSync(`${home}/home/targets/fx.json`, JSON.stringify({ ...target, checkCommit: 'abc1234' }))
  const worker = await mountWorker(main, { host: host([{ name: 'repo', branch: 'main', path: repo }]) })
  const { text } = await worker.request('target.export', { id: 'fx' })
  assert.ok(!text.includes(home), '내보낸 글자에 이 PC 의 경로가 들어가면 안 된다')
  assert.ok(text.includes('"checkCommit": "abc1234"'))

  const same = await worker.request('target.import', { text })
  assert.deepEqual(same.errors, [])
  assert.ok(same.draft!.repo.toLowerCase().endsWith('/repo'), same.draft!.repo)
  assert.ok(same.draft!.runs.endsWith('/home/runs/fx'), same.draft!.runs)
  assert.ok(same.notes.some((n) => n.includes('지금 작업공간의 저장소')))
  assert.ok(same.notes.some((n) => n.includes('같은 이름의 대상(fx)이 이미 있습니다')))

  // 이름이 겹치지 않으면 그 말이 없고, 저장까지 된다
  const other = await worker.request('target.import', { text: text.replace('"id": "fx"', '"id": "fx2"') })
  assert.ok(!other.notes.some((n) => n.includes('이미 있습니다')))
  assert.deepEqual((await worker.request('target.save', { target: other.draft!, previousId: null })).errors, [])
  // 같은 이름으로는 저장되지 않는다(덮어쓰지 않음)
  const clash = await worker.request('target.save', { target: same.draft!, previousId: null })
  assert.match(clash.errors[0], /같은 이름의 대상이 이미 있음/)

  const bad = await worker.request('target.import', { text: 'hello' })
  assert.equal(bad.draft, null)
  assert.match(bad.errors[0], /JSON 아님/)
  await worker.deactivate()
})

test('대상 가져오기: 작업공간을 정하지 못하면 메인 체크아웃을 비워 두고 직접 넣으라고 알려 준다', async () => {
  const worker = await mountWorker(main, { host: host([]) })
  const { text } = await worker.request('target.export', { id: 'fx' })
  const r = await worker.request('target.import', { text: text.replace('"id": "fx"', '"id": "fx3"') })
  assert.equal(r.draft!.repo, '')
  assert.ok(r.notes.some((n) => n.includes('메인 체크아웃 경로를 직접 넣으세요')))
  await worker.deactivate()
})

test('대상 내보내기: 받는 쪽에서 거절될 설정(계정이 섞인 호스트)은 내보내지 않는다', async () => {
  // 예전에 저장된 설정 파일을 흉내 낸다: 저장 검사를 거치지 않고 파일에 직접 쓴다
  const old = { ...target, id: 'oldhost', connection: { ...target.connection, host: 'user:pass@127.0.0.1' } }
  writeFileSync(`${home}/home/targets/oldhost.json`, JSON.stringify(old))
  const worker = await mountWorker(main, { host: host([]) })
  try {
    await worker.request('target.export', { id: 'oldhost' })
    assert.fail('계정이 든 호스트가 내보내짐')
  } catch (e) {
    const msg = String((e as Error).message)
    assert.match(msg, /내보낼 수 없음/)
    assert.match(msg, /호스트는 서버 이름이나 IP 주소만/)
    assert.ok(!msg.includes('user:pass'), '오류 말에도 계정을 옮겨 적지 않는다')
  }
  await worker.deactivate()
})

test('대상 가져오기: 확인용 커밋이 없으면 알려 주고, run 기록 폴더가 저장소 안이면 그것도 알려 준다', async () => {
  writeFileSync(`${home}/home/targets/fx.json`, JSON.stringify(target))
  // 플러그인 데이터 폴더(${home}/home)를 품는 저장소를 지금 작업공간으로 둔다
  spawnSync('git', ['init', '-q', '-b', 'main', home])
  const worker = await mountWorker(main, { host: host([{ name: 'repo', branch: 'main', path: home }]) })
  const { text } = await worker.request('target.export', { id: 'fx' })
  const r = await worker.request('target.import', { text: text.replace('"id": "fx"', '"id": "fx4"') })
  assert.deepEqual(r.errors, [])
  assert.ok(r.notes.some((n) => n.includes('확인용 커밋이 없습니다')), JSON.stringify(r.notes))
  assert.ok(r.notes.some((n) => n.includes('가 저장소 안입니다')), JSON.stringify(r.notes))
  await worker.deactivate()
})

test('대상 가져오기: 저장소 이름표로 그 저장소를 받아 둔 폴더를 찾는다 — 이름이 같은 작업공간이 여럿이어도', async () => {
  // 같은 저장소를 받아 둔 폴더 둘(main 과 기능 브랜치)과, 다른 저장소 하나. 작업공간 이름은 모두 main 으로 겹친다.
  const mk = (dir: string, url: string, branch: string) => {
    mkdirSync(dir, { recursive: true })
    spawnSync('git', ['init', '-q', '-b', branch, dir])
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', url])
    writeFileSync(`${dir}/a.txt`, 'a')
    spawnSync('git', ['-C', dir, 'add', '-A'])
    spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init'])
  }
  const mainDir = `${home}/checkouts/app-main`
  const featDir = `${home}/checkouts/app-feat`
  const otherDir = `${home}/checkouts/other`
  mk(mainDir, 'https://someone:secretToken@example.com/Team/App.git', 'main')
  mk(featDir, 'git@example.com:Team/App.git', 'feat/x')
  mk(otherDir, 'https://example.com/team/other.git', 'main')
  writeFileSync(`${home}/home/targets/app.json`, JSON.stringify({ ...target, id: 'app', repo: mainDir, checkCommit: 'abc1234' }))

  const worker = await mountWorker(main, {
    host: host([
      { name: 'main', branch: 'main', path: otherDir },
      { name: 'main', branch: 'feat/x', path: featDir },
      { name: 'main', branch: 'main', path: mainDir }
    ])
  })
  const { text } = await worker.request('target.export', { id: 'app' })
  assert.ok(text.includes('"remote": "example.com/Team/App"'), text)
  assert.ok(!text.includes('secretToken') && !text.includes('someone'), '원격 주소의 계정·토큰은 나가지 않는다')

  const r = await worker.request('target.import', { text: text.replace('"id": "app"', '"id": "app2"') })
  assert.deepEqual(r.errors, [])
  assert.ok(r.draft!.repo.toLowerCase().endsWith('/checkouts/app-main'), `main 을 받아 둔 폴더를 골라야 한다: ${r.draft!.repo}`)
  assert.ok(r.notes.some((n) => n.includes('이 대상의 저장소(example.com/Team/App)를 받아 둔 폴더')), JSON.stringify(r.notes))
  assert.ok(!r.notes.some((n) => n.includes('브랜치에서만 됩니다')), 'main 폴더를 골랐으면 브랜치 경고가 없다')
  await worker.deactivate()

  // main 을 받아 둔 폴더가 없으면 있는 폴더를 넣고 브랜치가 다르다고 알려 준다
  const featOnly = await mountWorker(main, { host: host([{ name: 'main', branch: 'feat/x', path: featDir }]) })
  const f = await featOnly.request('target.import', { text: text.replace('"id": "app"', '"id": "app3"') })
  assert.ok(f.draft!.repo.toLowerCase().endsWith('/checkouts/app-feat'), f.draft!.repo)
  assert.ok(f.notes.some((n) => n.includes('지금 feat/x 브랜치입니다')), JSON.stringify(f.notes))
  await featOnly.deactivate()

  // 그 저장소를 받아 둔 작업공간이 없으면 비워 두고 알려 준다(다른 저장소를 넣지 않는다)
  const none = await mountWorker(main, { host: host([{ name: 'main', branch: 'main', path: otherDir }]) })
  const n = await none.request('target.import', { text: text.replace('"id": "app"', '"id": "app4"') })
  assert.equal(n.draft!.repo, '')
  assert.ok(n.notes.some((x) => x.includes('받아 둔 작업공간을 Orca 에서 찾지 못했습니다')), JSON.stringify(n.notes))
  await none.deactivate()
})

test('대상 가져오기: origin 이 다른 저장소인 폴더(upstream 만 같은 fork)나 포트가 다른 서버는 고르지 않는다', async () => {
  const mk = (dir: string, remotes: Record<string, string>) => {
    mkdirSync(dir, { recursive: true })
    spawnSync('git', ['init', '-q', '-b', 'main', dir])
    for (const [name, url] of Object.entries(remotes)) spawnSync('git', ['-C', dir, 'remote', 'add', name, url])
  }
  const forkDir = `${home}/checkouts/fork`
  const portDir = `${home}/checkouts/other-port`
  mk(forkDir, { origin: 'https://example.com/someone/App.git', upstream: 'https://example.com/Team/App.git' })
  mk(portDir, { origin: 'https://example.com:8443/Team/App.git' })
  const worker = await mountWorker(main, {
    host: host([
      { name: 'main', branch: 'main', path: forkDir },
      { name: 'main', branch: 'main', path: portDir }
    ])
  })
  // 앞 시험에서 만든 대상(app): 저장소 이름표는 example.com/Team/App
  const { text } = await worker.request('target.export', { id: 'app' })
  const r = await worker.request('target.import', { text: text.replace('"id": "app"', '"id": "app5"') })
  assert.equal(r.draft!.repo, '', JSON.stringify(r.notes))
  assert.ok(r.notes.some((n) => n.includes('받아 둔 작업공간을 Orca 에서 찾지 못했습니다')))
  await worker.deactivate()
})
