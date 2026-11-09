// 상태 표시줄을 누르면 패널 열기: 플러그인 키 찾기와 Orca CLI 호출 순서.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPanel, orcaCliCandidates, pickPluginKey } from '../src/open-panel.ts'

const list = (plugins: unknown[]) => JSON.stringify({ ok: true, result: { plugins } })
const ours = (key: string, isDev: boolean, status = 'running') => ({ pluginKey: key, isDev, status, panels: [{ id: 'deploy' }] })

test('플러그인 키: 돌고 있는 prod-deploy 중 개발 폴더 쪽, 다른 플러그인·멈춘 것은 뺌', () => {
  assert.equal(pickPluginKey(list([ours('srp-david.prod-deploy', false), ours('local.prod-deploy', true)])), 'local.prod-deploy')
  assert.equal(pickPluginKey(list([ours('srp-david.prod-deploy', false)])), 'srp-david.prod-deploy')
  assert.equal(pickPluginKey(list([ours('local.prod-deploy', true, 'disabled')])), null)
  assert.equal(pickPluginKey(list([{ pluginKey: 'x.prod-deploy-other', status: 'running', panels: [{ id: 'deploy' }] }])), null)
  assert.equal(pickPluginKey('not json'), null)
})

test('Orca CLI 후보: Windows 는 PATH → 기본 설치 위치 → Orca 옆', () => {
  const c = orcaCliCandidates({ LOCALAPPDATA: 'C:\\L' }, 'C:\\O\\Orca.exe', 'win32')
  assert.equal(c[0], 'orca.exe')
  assert.ok(c.some((x) => x.replace(/\\/g, '/') === 'C:/L/Programs/orca/resources/bin/orca.exe'))
  assert.ok(c.some((x) => x.replace(/\\/g, '/') === 'C:/O/resources/bin/orca.exe'))
  assert.deepEqual(orcaCliCandidates({}, '/x', 'darwin'), ['orca'])
})

test('패널 열기: 없는 CLI 는 건너뛰고, 찾은 키로 plugin open --panel deploy', async () => {
  const calls: string[] = []
  const why = await openPanel(async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`)
    if (cmd === 'missing.exe') return { code: -1, out: Buffer.alloc(0), err: 'ENOENT' }
    if (args[1] === 'list') return { code: 0, out: Buffer.from(list([ours('local.prod-deploy', true)])), err: '' }
    return { code: 0, out: Buffer.alloc(0), err: '' }
  }, ['missing.exe', 'orca.exe'])
  assert.equal(why, null)
  assert.deepEqual(calls, ['missing.exe plugin list --json', 'orca.exe plugin list --json', 'orca.exe plugin open local.prod-deploy --panel deploy'])
})

test('패널 열기: 실패하면 이유를 돌려준다', async () => {
  const none = await openPanel(async () => ({ code: -1, out: Buffer.alloc(0), err: 'ENOENT' }), ['a.exe'])
  assert.match(none ?? '', /찾지 못함/)
  const refused = await openPanel(async (_c, args) =>
    args[1] === 'list'
      ? { code: 0, out: Buffer.from(list([ours('local.prod-deploy', true)])), err: '' }
      : { code: 1, out: Buffer.alloc(0), err: 'no_workspace: open a workspace first\n' }, ['orca.exe'])
  assert.match(refused ?? '', /no_workspace/)
})
