// 대상 설정 공유: 내보낸 글자에 개인 정보가 없고, 받은 글자는 엄격히 검사한다.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { exportChecked, exportTarget, exportText, parseShared, repoIdentity, sameRepoIdentity, sharedToTarget, SHARE_FORMAT } from '../src/engine/share.ts'
import { validateTarget, type Target } from '../src/engine/target.ts'

const example = JSON.parse(readFileSync(new URL('../examples/java-war.json', import.meta.url), 'utf8')) as Target
const mine: Target = {
  ...example,
  repo: 'C:/Users/me/secret-path/my-app',
  runs: 'C:/Users/me/secret-path/runs',
  gitRemote: 'upstream',
  legacyNetrc: 'C:/Users/me/.netrc',
  test: true,
  checkCommit: 'abc1234',
  java: { ...example.java!, build: 'set JAVA_HOME=C:/Users/me/jdk8 && gradlew classes' }
}
const good = () => JSON.parse(exportText(mine)) as Record<string, unknown>
const errorsOf = (change: (o: Record<string, any>) => void): string[] => {
  const o = good()
  change(o)
  const r = parseShared(JSON.stringify(o))
  assert.equal(r.shared, null)
  return r.errors
}

test('내보내기: 팀 공통 설정만 담고 개인 경로·netrc·빌드 명령·원격 이름은 뺀다', () => {
  const text = exportText(mine)
  assert.doesNotMatch(text, /secret-path|netrc|JAVA_HOME|upstream|gradlew/)
  assert.deepEqual(Object.keys(exportTarget(mine)).sort(), [
    'checkCommit', 'connection', 'format', 'id', 'java', 'label', 'mainBranch', 'manual', 'mappings', 'test', 'version'
  ])
  assert.deepEqual(Object.keys(exportTarget(mine).java!).sort(), ['major', 'output', 'source'])
})

test('가져오기: 내보낸 글자를 그대로 읽고, 받은 사람의 경로 두 개만 더하면 쓸 수 있는 설정이 된다', () => {
  const r = parseShared(exportText(mine))
  assert.deepEqual(r.errors, [])
  const t = sharedToTarget(r.shared!, 'D:/work/my-app', 'D:/runs/myapp')
  assert.deepEqual(validateTarget(t), [])
  assert.equal(t.repo, 'D:/work/my-app')
  assert.equal(t.runs, 'D:/runs/myapp')
  assert.equal(t.test, true, '시험용 표시는 그대로 온다')
  assert.equal(t.checkCommit, 'abc1234')
  assert.deepEqual(t.connection, mine.connection)
  assert.deepEqual(t.mappings, mine.mappings)
  assert.deepEqual(t.manual, mine.manual, '손 처리 규칙은 순서까지 그대로')
  assert.equal(t.java!.build, undefined)
  assert.equal(t.legacyNetrc, undefined)
})

test('가져오기: 메신저의 코드 블록 표시와 앞뒤 빈칸은 떼고 읽는다', () => {
  const r = parseShared('\uFEFF  ```json\n' + exportText(mine) + '\n```  \n')
  assert.deepEqual(r.errors, [])
  assert.equal(r.shared!.id, 'myapp')
})

test('가져오기: 내보낸 글자가 아니면 읽지 않는다', () => {
  assert.match(parseShared('').errors[0], /붙여 넣은 글자가 없음/)
  assert.match(parseShared('hello').errors[0], /JSON 아님/)
  assert.match(parseShared('[1]').errors[0], /내보낸 글자가 아님/)
  assert.match(parseShared('{"a":1}').errors[0], /"내보내기"로 만든 글자/)
  // 대상 설정 파일을 그대로 붙여 넣은 경우는 따로 알려 준다
  assert.match(parseShared(JSON.stringify(mine)).errors[0], /대상 설정 파일을 그대로/)
  assert.match(parseShared('x'.repeat(300_000)).errors[0], /너무 김/)
})

test('가져오기: 모르는 형식 버전은 거절한다', () => {
  assert.match(errorsOf((o) => (o.version = 2))[0], /새 형식\(v2\).*최신으로/)
  assert.match(errorsOf((o) => (o.version = 0))[0], /지원하지 않는 형식 버전/)
  assert.match(errorsOf((o) => delete o.version)[0], /형식 버전이 없음/)
  assert.equal(good().format, SHARE_FORMAT)
})

test('가져오기: 모르는 항목은 조용히 버리지 않고 거절한다', () => {
  assert.deepEqual(errorsOf((o) => (o.repo2 = 'x')), ['알 수 없는 항목: repo2'])
  assert.deepEqual(errorsOf((o) => (o.connection.user = 'u')), ['연결의 알 수 없는 항목: user'])
  assert.deepEqual(errorsOf((o) => (o.java.build = 'rm -rf')), ['Java 빌드 출력의 알 수 없는 항목: build'])
  assert.deepEqual(errorsOf((o) => (o.mappings[0].extra = 1)), ['경로 매핑 1의 알 수 없는 항목: extra'])
})

test('가져오기: 칸의 형식이 틀리면 거절한다', () => {
  assert.match(errorsOf((o) => (o.label = 42))[0], /표시 이름: 글자가 아님/)
  assert.match(errorsOf((o) => (o.id = 'My-App'))[0], /이름: 영문 소문자/)
  assert.match(errorsOf((o) => (o.test = 'yes'))[0], /시험용 대상: true\/false/)
  assert.match(errorsOf((o) => (o.connection.port = '21'))[0], /포트/)
  assert.match(errorsOf((o) => (o.connection.protocol = 'sftp'))[0], /ftp 만/)
  assert.match(errorsOf((o) => (o.connection = 'ftp.example.com'))[0], /연결: 없음/)
  assert.match(errorsOf((o) => (o.mappings = []))[0], /하나 이상/)
  assert.match(errorsOf((o) => (o.java.major = '52'))[0], /class major/)
  assert.match(errorsOf((o) => (o.label = 'a'.repeat(101)))[0], /너무 김/)
})

test('가져오기: 저장소나 운영 루트 밖으로 나가는 경로는 거절한다', () => {
  assert.match(errorsOf((o) => (o.mappings[0].local = '..\\outside'))[0], /\.\. 은 못 씀/)
  assert.match(errorsOf((o) => (o.mappings[0].local = 'C:/Windows'))[0], /상대 경로/)
  assert.match(errorsOf((o) => (o.mappings[0].remote = '/a/../../etc'))[0], /\.\. 은 못 씀/)
  assert.match(errorsOf((o) => (o.connection.root = '/app/../other'))[0], /\.\. 은 못 씀/)
  assert.match(errorsOf((o) => (o.java.source = '../src'))[0], /\.\. 은 못 씀/)
  assert.match(errorsOf((o) => (o.java.output = '/abs/out'))[0], /상대 경로/)
})

test('가져오기: 줄바꿈·탭이 든 값은 거절한다 — run 기록의 줄이 깨지지 않게', () => {
  assert.match(errorsOf((o) => (o.manual[0].reason = 'a\tb'))[0], /제어 문자/)
  assert.match(errorsOf((o) => (o.manual[0].pattern = 'a\nb'))[0], /제어 문자/)
  assert.match(errorsOf((o) => (o.label = 'x\r\ny'))[0], /제어 문자/)
})

test('가져오기: 형식은 맞아도 뜻이 틀리면 거절한다(class 를 운영에 잇는 매핑 없음)', () => {
  const e = errorsOf((o) => (o.mappings = [{ local: 'src/main/webapp', remote: '/' }]))
  assert.match(e[0], /Java 빌드 결과 폴더를 운영에 잇는 경로 매핑이 없음/)
})

test('설정 검사: 글자가 아닌 값·밖으로 나가는 경로에 넘어지지 않고 잘못을 알려 준다', () => {
  const bad = (change: (t: any) => void): string[] => {
    const t = JSON.parse(JSON.stringify(example))
    change(t)
    return validateTarget(t)
  }
  assert.ok(bad((t) => (t.label = 42)).some((x) => /표시 이름/.test(x)))
  assert.ok(bad((t) => (t.mappings[0].local = '..\\outside')).some((x) => /\.\. 은 못 씀/.test(x)))
  assert.ok(bad((t) => (t.java.source = '../src')).some((x) => /Java 빌드 출력: \.\. 은 못 씀/.test(x)))
  assert.ok(bad((t) => (t.mappings = [{ local: 1, remote: 2 }])).some((x) => /로컬 경로와 운영 경로가 필요함/.test(x)))
  assert.ok(bad((t) => (t.manual = [{ pattern: 1 }])).some((x) => /패턴이 비었음/.test(x)))
  assert.ok(bad((t) => (t.connection = null)).some((x) => /연결 설정이 필요함/.test(x)))
})

test('호스트: 서버 이름·IP 만 받는다 — 계정·포트·경로가 섞이면 접속하는 곳이 달라지고 계정이 글자에 남는다', () => {
  const host = (h: string) => validateTarget({ ...example, connection: { ...example.connection, host: h } })
  for (const ok of ['ftp.example.com', '10.0.0.5', 'ftp-01.internal', 'ftp_server', 'localhost']) assert.deepEqual(host(ok), [], ok)
  for (const bad of ['user:pass@ftp.example.com', 'ftp.example.com:2121', 'ftp.example.com#x', 'ftp.example.com?x', 'ftp.example.com/a', 'ftp://ftp.example.com', ' ftp.example.com', '-ftp.example.com', '[::1]', ''])
    assert.ok(host(bad).some((x) => /호스트는 서버 이름이나 IP 주소만/.test(x)), bad)
  // 받는 쪽도 같은 검사를 한다
  assert.match(errorsOf((o) => (o.connection.host = 'user:pass@ftp.example.com'))[0], /호스트는 서버 이름이나 IP 주소만/)
})

test('내보내기: 받는 쪽에서 거절될 설정은 내보내지 않고 이유를 알려 준다', () => {
  assert.deepEqual(exportChecked(mine).errors, [])
  assert.equal(exportChecked(mine).text, exportText(mine))
  const withAccount = exportChecked({ ...mine, connection: { ...mine.connection, host: 'user:pass@ftp.example.com' } })
  assert.equal(withAccount.text, null, '계정이 섞인 호스트는 글자로 나가지 않는다')
  assert.match(withAccount.errors[0], /호스트는 서버 이름이나 IP 주소만/)
  const longLabel = exportChecked({ ...mine, label: 'a'.repeat(101) })
  assert.equal(longLabel.text, null)
  assert.match(longLabel.errors[0], /표시 이름: 너무 김/)
})

test('가져오기: 저장소 맨 위를 잇는 매핑(로컬 경로가 빈 글자)도 그대로 오간다', () => {
  const rootMapped: Target = { ...mine, java: undefined, mappings: [{ local: '', remote: '/' }] }
  assert.deepEqual(validateTarget(rootMapped), [])
  const r = parseShared(exportText(rootMapped))
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.shared!.mappings, [{ local: '', remote: '/' }])
})

test('가져오기: 보이지 않는 글자·글 방향을 바꾸는 글자가 든 값은 거절한다', () => {
  assert.match(errorsOf((o) => (o.mappings[0].local = 'src/main​/webapp'))[0], /보이지 않는 글자/)
  assert.match(errorsOf((o) => (o.manual[0].pattern = 'a‮b'))[0], /보이지 않는 글자/)
})

test('가져오기: 같은 항목이 두 번 적혀 있으면 뒤의 값을 쓰고, 그 값을 검사한다', () => {
  const text = exportText(mine).replace('"id": "myapp"', '"id": "first", "id": "second_one"')
  assert.equal(parseShared(text).shared!.id, 'second_one')
  const bad = exportText(mine).replace('"id": "myapp"', '"id": "fine", "id": "Not-Allowed"')
  assert.match(parseShared(bad).errors[0], /이름: 영문 소문자/)
})

test('저장소 이름표: 원격 주소 앞의 계정·토큰과 프로토콜·.git 을 떼고, 호스트만 소문자로 한다', () => {
  assert.equal(repoIdentity('https://GitHub.com/Team/App.git'), 'github.com/Team/App')
  assert.equal(repoIdentity('https://user:ghp_secretToken@github.com/Team/App.git'), 'github.com/Team/App')
  assert.equal(repoIdentity('git@github.com:Team/App.git'), 'github.com/Team/App')
  assert.equal(repoIdentity('https://git.example.com/group/sub/app/'), 'git.example.com/group/sub/app')
  // 기본 포트는 떼고, 다른 포트는 남긴다(같은 서버의 다른 포트는 다른 서비스)
  assert.equal(repoIdentity('https://git.example.com:443/group/app.git'), 'git.example.com/group/app')
  assert.equal(repoIdentity('ssh://git@git.example.com:22/group/app.git'), 'git.example.com/group/app')
  assert.equal(repoIdentity('https://git.example.com:8443/Team/App.git'), 'git.example.com:8443/Team/App')
  assert.equal(repoIdentity('ssh://git@git.example.com:2222/group/app.git'), 'git.example.com:2222/group/app')
  // 원격 저장소가 아닌 주소(이 PC 나 공유 폴더의 경로)는 이름표로 만들지 않는다
  for (const local of ['C:/work/repos/app', 'C:\\work\\repos\\app', '/srv/git/app.git', 'file:///C:/work/app', 'file://server/private/team/app.git', '../app', ''])
    assert.equal(repoIdentity(local), null, local)
  // 주소 뒤에 ?·# 로 붙은 값이나 빈칸이 든 주소는 통째로 버린다(토큰이 섞여 나가지 않게)
  for (const odd of ['https://git.example.com/team/app.git?token=abc', 'https://git.example.com/team/app#frag', 'https://git.example.com/team/my app.git'])
    assert.equal(repoIdentity(odd), null, odd)
})

test('저장소 이름표 견주기: 다른 포트·다른 대소문자를 같은 저장소로 보지 않는다(대소문자를 안 가리는 호스트만 예외)', () => {
  const a = repoIdentity('https://git.example.com:8443/Team/App.git')!
  const b = repoIdentity('https://git.example.com:9443/team/app.git')!
  assert.equal(sameRepoIdentity(a, b), false)
  assert.equal(sameRepoIdentity('git.example.com/Team/App', 'git.example.com/team/app'), false)
  assert.equal(sameRepoIdentity('git.example.com/team/app', 'git.example.com/team/app'), true)
  // github.com 은 경로의 대소문자를 가리지 않는다
  assert.equal(sameRepoIdentity(repoIdentity('git@github.com:Team/App.git')!, repoIdentity('https://github.com/team/app')!), true)
  assert.equal(sameRepoIdentity('github.com/team/app', 'github.com/team/other'), false)
})

test('내보내기·가져오기: 저장소 이름표는 형식이 맞을 때만 오간다', () => {
  const text = exportText(mine, 'github.com/Team/App')
  assert.ok(text.includes('"remote": "github.com/Team/App"'))
  assert.equal(parseShared(text).shared!.remote, 'github.com/Team/App')
  assert.equal(parseShared(exportText(mine, 'git.example.com:8443/team/app')).shared!.remote, 'git.example.com:8443/team/app')
  // 이름표 모양이 아니면(계정이 든 주소 등) 내보내지 않는다
  // (경로 매핑에도 remote 라는 칸이 있으므로 맨 위 항목으로 본다)
  assert.equal(JSON.parse(exportText(mine, 'https://user:token@github.com/team/app')).remote, undefined)
  assert.ok(!exportText(mine, 'https://user:token@github.com/team/app').includes('token'))
  assert.equal(JSON.parse(exportText(mine, null)).remote, undefined)
  // 받는 쪽도 모양을 본다
  assert.match(errorsOf((o) => (o.remote = 'https://user:token@github.com/team/app'))[0], /저장소 주소: 형식이 틀림/)
  assert.match(errorsOf((o) => (o.remote = 'C:/work/app'))[0], /저장소 주소: 형식이 틀림/)
})
