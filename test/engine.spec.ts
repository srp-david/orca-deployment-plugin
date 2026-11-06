// 엔진 단위 시험: node --test test/
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { deployNotes } from '../src/engine/git.ts'
import { parseSpec } from '../src/engine/plan.ts'
import { confirmCode } from '../src/engine/runs.ts'
import { findMapping, globToRegExp, manualReason, remotePathOf, validateTarget, type Target } from '../src/engine/target.ts'
import { toMsys, toNative } from '../src/engine/util.ts'

const example = JSON.parse(readFileSync(new URL('../examples/java-war.json', import.meta.url), 'utf8')) as Target

test('예시 설정은 검사를 통과한다', () => {
  assert.deepEqual(validateTarget(example), [])
})

test('글롭: ** 는 폴더를 넘고 * 는 넘지 않는다', () => {
  assert.ok(globToRegExp('src/main/webapp/META-INF/**').test('src/main/webapp/META-INF/a/b.xml'))
  assert.ok(globToRegExp('a/*.js').test('a/x.js'))
  assert.ok(!globToRegExp('a/*.js').test('a/b/x.js'))
  assert.ok(globToRegExp('a/**/x.js').test('a/x.js'))
  assert.ok(globToRegExp('a/**/x.js').test('a/b/c/x.js'))
  assert.ok(!globToRegExp('a.b').test('aXb'))
})

test('손 처리 규칙: 위에서부터 처음 맞는 규칙', () => {
  assert.match(manualReason(example, 'src/main/webapp/WEB-INF/web.xml') ?? '', /별도 파일/)
  assert.match(manualReason(example, 'src/main/webapp/META-INF/context.xml') ?? '', /별도 파일/)
  assert.match(manualReason(example, 'src/main/resources/logback.xml') ?? '', /환경별/)
  assert.match(manualReason(example, 'libs/x.jar') ?? '', /jar/)
  assert.equal(manualReason(example, 'src/main/webapp/ui/ws/a.xml'), null)
})

test('경로 매핑: bash 와 같은 운영 경로', () => {
  assert.equal(remotePathOf(example, 'src/main/webapp/ui/ws/a.xml'), '/webapps/ROOT/ui/ws/a.xml')
  assert.equal(remotePathOf(example, 'build/classes/java/main/com/x/A$1.class'), '/webapps/ROOT/WEB-INF/classes/com/x/A$1.class')
  assert.equal(remotePathOf(example, 'README.md'), null)
  assert.equal(remotePathOf(example, 'src/main/webappx/a.xml'), null)
})

test('경로 매핑: 가장 구체적인 매핑이 이긴다', () => {
  const t: Target = { ...example, mappings: [...example.mappings, { local: 'src/main/webapp/static', remote: '/cdn' }] }
  assert.equal(findMapping(t, 'src/main/webapp/static/a.js')?.remote, '/cdn')
  assert.equal(remotePathOf(t, 'src/main/webapp/static/a.js'), '/webapps/ROOT/cdn/a.js')
  assert.equal(remotePathOf(t, 'src/main/webapp/a.js'), '/webapps/ROOT/a.js')
})

test('설정 검사: 매핑 패턴·- 든 이름·class 매핑 없음을 잡는다', () => {
  assert.ok(validateTarget({ ...example, id: 'g-g' }).some((e) => e.includes('- 는')))
  assert.ok(validateTarget({ ...example, mappings: [{ local: 'src/*', remote: '/' }] }).some((e) => e.includes('패턴')))
  assert.ok(validateTarget({ ...example, mappings: [example.mappings[0]] }).some((e) => e.includes('Java 빌드 결과')))
})

test('경로 형식: bash(/c/..) ↔ Windows(C:/..)', () => {
  assert.equal(toMsys('C:/work/repos/my-app'), '/c/work/repos/my-app')
  assert.equal(toMsys('C:\\work\\x'), '/c/work/x')
  assert.equal(toNative('/c/work/repos/my-app/a.xml'), 'C:/work/repos/my-app/a.xml')
  assert.equal(toNative('relative/x'), 'relative/x')
})

test('확인 코드: bash 의 sha256sum 결과와 같다', () => {
  const tsv = 'M\t/c/r/src/main/webapp/a.xml\t/webapps/ROOT/a.xml\taaa\tbbb\t\nA\t/c/r/b.class\t/webapps/ROOT/WEB-INF/classes/b.class\tccc\t-\t\n'
  const bash = execFileSync('bash', ['-c', `{ printf '%s\\n' myapp; printf '%s' "$1"; } | sha256sum | cut -c1-8`, '_', tsv]).toString().trim()
  assert.equal(confirmCode('myapp', tsv), bash)
  assert.notEqual(confirmCode('test', tsv), bash)
})

test('반영 대상 입력: PR·커밋·구간', () => {
  assert.deepEqual(parseSpec('#123'), { kind: 'pr', pr: 123 })
  assert.deepEqual(parseSpec('123'), { kind: 'pr', pr: 123 })
  assert.deepEqual(parseSpec('a1b2c3d4'), { kind: 'commit', rev: 'a1b2c3d4' })
  assert.deepEqual(parseSpec('a1..b2'), { kind: 'range', base: 'a1', tip: 'b2' })
})

test('PR 본문의 "반영 시 주의" 절', () => {
  const body = '## 요약\n바꿈\n\n## 반영 시 주의\n1. SQL 먼저\n2. 톰캣 재기동\n### 세부\n- x\n## 시험\n- y'
  assert.equal(deployNotes(body), '1. SQL 먼저\n2. 톰캣 재기동\n### 세부\n- x')
  assert.equal(deployNotes('## 요약\n없음'), null)
})
