// 스킬의 guard 훅: 운영 쓰기·안전장치 해제 명령이면 확인 창(ask), 읽기 명령이면 통과.
// Claude Code 가 넘기는 것과 같은 JSON 으로 훅을 돌린다(명령 안의 따옴표는 \" 로 이스케이프됨).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const hook = fileURLToPath(new URL('../skill/prod-deploy/guard-hook.sh', import.meta.url))
const cases = JSON.parse(readFileSync(new URL('./guard-hook.cases.json', import.meta.url), 'utf8')) as ['ask' | 'pass', string][]

function decide(tool: string, command: string, description = 'x'): 'ask' | 'pass' {
  const input = JSON.stringify({ tool_name: tool, tool_input: { command, description } })
  const r = spawnSync('bash', [hook], { input, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  if (!r.stdout.trim()) return 'pass'
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask')
  return 'ask'
}

for (const [want, command] of cases) {
  test(`${want}: ${command}`, () => {
    assert.equal(decide('Bash', command), want)
    assert.equal(decide('PowerShell', command), want)
  })
}

test('명령 밖(description)의 낱말로는 묻지 않는다', () => {
  assert.equal(decide('Bash', 'node src/cli.ts backup gg-1', 'Back up before upload'), 'pass')
})
