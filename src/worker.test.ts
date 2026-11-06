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
      'statusBar.update': { ok: true }
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
