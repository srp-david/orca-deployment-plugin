import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cliSpawnError } from '../src/cli-spawn.ts'
import { repoProblem } from '../src/engine/target.ts'

const spawnError = (cmd: string, cwd?: string) =>
  new Promise<NodeJS.ErrnoException>((resolve) => {
    spawn(cmd, [], { stdio: 'ignore', cwd }).on('error', resolve)
  })

test('ENOENT 는 node 없음과 폴더 문제를 둘 다 알려 준다 — spawn 이 두 경우를 같은 말로 알려 주므로', async () => {
  // 없는 명령과 없는 폴더(cwd)가 실제로 같은 code 를 낸다.
  const noCommand = await spawnError('prod-deploy-no-such-command')
  const noFolder = await spawnError(process.execPath, join(tmpdir(), 'prod-deploy-no-such-folder'))
  assert.equal(noCommand.code, 'ENOENT')
  assert.equal(noFolder.code, 'ENOENT')
  const msg = cliSpawnError(noFolder, 'C:/work/repos/my-app')
  assert.match(msg, /Windows 에서 node 를 찾지 못했거나 메인 체크아웃 폴더\(C:\/work\/repos\/my-app\)를 열 수 없음/)
  assert.match(msg, /WSL 안에 설치한 Node 는 쓰지 못합니다/)
  assert.ok(msg.includes(noFolder.message), '원래 오류 말을 남긴다')
})

test('다른 오류는 원래 말을 그대로 붙인다', () => {
  assert.equal(cliSpawnError({ code: 'EACCES', message: 'spawn node EACCES' }, 'C:/x'), 'CLI 를 띄우지 못함: spawn node EACCES')
})

test('메인 체크아웃 확인: 없는 경로와 폴더가 아닌 경로는 문제, 있는 폴더는 통과', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-repo-')).replace(/\\/g, '/')
  writeFileSync(`${dir}/file.txt`, 'x')
  assert.equal(repoProblem(dir), null)
  assert.match(repoProblem(`${dir}/nope`) ?? '', /메인 체크아웃이 없음: .*nope/)
  assert.match(repoProblem(`${dir}/file.txt`) ?? '', /메인 체크아웃이 없음/)
})
