// "저장소에서 채우기": 메인 체크아웃의 폴더 구조로 대상 설정을 제안한다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { isDir, majorFromBuildFile, majorOfJava, mergeSuggestion, suggestFromRepo, type Suggestion } from '../src/engine/suggest.ts'
import { validateTarget, type Target } from '../src/engine/target.ts'
import { makeClass } from './class-fixture.ts'

const tmp = mkdtempSync(join(tmpdir(), 'pd-suggest-')).replace(/\\/g, '/')

function repoWith(name: string, files: Record<string, string | Buffer>): string {
  const root = `${tmp}/${name}`
  mkdirSync(root, { recursive: true })
  spawnSync('git', ['init', '-q', '-b', 'main', root])
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(`${root}/${rel}`), { recursive: true })
    writeFileSync(`${root}/${rel}`, body)
  }
  spawnSync('git', ['-C', root, 'add', '-A'])
  return root
}

const gradleWar = {
  'build.gradle': "apply plugin: 'war'\nsourceCompatibility = '1.8'\ntargetCompatibility = '1.8'\n",
  'gradlew.bat': '@echo off\n',
  'src/main/java/com/x/Foo.java': 'package com.x; class Foo {}\n',
  'src/main/webapp/index.jsp': '<html/>\n',
  'src/main/webapp/WEB-INF/web.xml': '<web-app/>\n',
  'src/main/webapp/META-INF/context.xml': '<Context/>\n',
  'src/main/resources/logback.xml': '<configuration/>\n',
  'libs/a.jar': 'jar'
}

test('Gradle WAR: 화면 폴더·class 결과 폴더의 매핑과 Java 설정, 서버마다 따로 두는 파일의 손 처리 규칙을 제안한다', async () => {
  const root = repoWith('gradle', gradleWar)
  const s = await suggestFromRepo(root)
  assert.deepEqual(s.mappings, [
    { local: 'src/main/webapp', remote: '/' },
    { local: 'build/classes/java/main', remote: '/WEB-INF/classes' }
  ])
  assert.deepEqual(s.java, { source: 'src/main/java', output: 'build/classes/java/main', major: 52, build: '.\\gradlew.bat classes' })
  assert.equal(s.majorFrom, 'build-file', '빌드 전이라 class 가 없으면 빌드 파일에서 읽는다')
  assert.deepEqual(
    s.manual.map((r) => r.pattern),
    ['src/main/webapp/WEB-INF/web.xml', 'src/main/webapp/META-INF/**', 'src/main/resources/**', 'libs/**']
  )
  assert.equal(s.mainBranch, null, '원격이 없으면 기본 브랜치를 모른다')
  // 제안만으로 쓸 수 있는 설정이 된다
  const t: Target = {
    id: 'app',
    label: 'App',
    repo: root,
    runs: `${tmp}/runs`,
    connection: { protocol: 'ftp', host: 'ftp.example.com', root: '/webapps/ROOT' },
    mappings: s.mappings,
    java: s.java!,
    manual: s.manual
  }
  assert.deepEqual(validateTarget(t), [])
})

test('빌드된 class 가 있으면 class 에서 Java 버전을 읽는다 — 빌드 파일에 적힌 것과 달라도', async () => {
  const root = repoWith('built', {
    ...gradleWar,
    'build.gradle': 'sourceCompatibility = 17\n',
    'build/classes/java/main/com/x/Foo.class': makeClass('com/x/Foo', [], 'foo', { major: 55, sourceFile: 'Foo.java' })
  })
  const s = await suggestFromRepo(root)
  assert.equal(s.java!.major, 55)
  assert.equal(s.majorFrom, 'class')
})

test('소스 폴더에 .java 가 아닌 파일(쿼리 XML 등)이 있으면 그 폴더도 classes 로 잇는다', async () => {
  const root = repoWith('mixed', { ...gradleWar, 'src/main/java/com/x/FooMapper.xml': '<mapper/>\n' })
  const s = await suggestFromRepo(root)
  assert.deepEqual(s.mappings[2], { local: 'src/main/java', remote: '/WEB-INF/classes' })
  assert.deepEqual(s.sourceExtras, { count: 1, samples: ['src/main/java/com/x/FooMapper.xml'] })
  // 왜 넣었는지, 무엇이 올라가게 되는지 알려 준다
  const merged = mergeSuggestion({ ...base, repo: root }, s, { tidy: true, exists: () => true })
  assert.ok(
    merged.notes.some((n) => n.includes('.java 가 아닌 파일이 1개 있어서') && n.includes('FooMapper.xml') && n.includes('이 매핑을 지우세요')),
    JSON.stringify(merged.notes)
  )
})

test('Maven: target/classes 와 mvn compile, pom 의 Java 버전', async () => {
  const root = repoWith('maven', {
    'pom.xml': '<project><properties><maven.compiler.source>11</maven.compiler.source><maven.compiler.target>11</maven.compiler.target></properties></project>\n',
    'src/main/java/com/x/Foo.java': 'package com.x; class Foo {}\n',
    'src/main/webapp/index.jsp': '<html/>\n'
  })
  const s = await suggestFromRepo(root)
  assert.deepEqual(s.java, { source: 'src/main/java', output: 'target/classes', major: 55, build: 'mvn compile' })
  assert.deepEqual(s.mappings[1], { local: 'target/classes', remote: '/WEB-INF/classes' })
  assert.deepEqual(s.manual, [], '없는 파일의 규칙은 만들지 않는다')
})

test('화면 파일만 있는 저장소: Java 는 제안하지 않는다. 아무 구조도 없으면 아무것도 제안하지 않는다', async () => {
  const web = await suggestFromRepo(repoWith('static', { 'WebContent/index.html': '<html/>\n' }))
  assert.deepEqual(web.mappings, [{ local: 'WebContent', remote: '/' }])
  assert.equal(web.java, null)
  const none = await suggestFromRepo(repoWith('empty', { 'README.md': 'x\n' }))
  assert.deepEqual([none.mappings, none.java, none.manual], [[], null, []])
})

test('Java 버전 표기 → class major', () => {
  assert.equal(majorOfJava('1.8'), 52)
  assert.equal(majorOfJava('1_8'), 52)
  assert.equal(majorOfJava('8'), 52)
  assert.equal(majorOfJava('17'), 61)
  assert.equal(majorOfJava('abc'), null)
  assert.equal(majorFromBuildFile('sourceCompatibility = JavaVersion.VERSION_1_8\ntargetCompatibility = JavaVersion.VERSION_11', ''), 55, 'target 이 먼저')
  assert.equal(majorFromBuildFile('java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }', ''), 65)
  assert.equal(majorFromBuildFile("sourceCompatibility '1.8'", ''), 52)
  assert.equal(majorFromBuildFile('', '<properties><java.version>1.8</java.version></properties>'), 52)
  assert.equal(majorFromBuildFile('', '<maven.compiler.release>17</maven.compiler.release>'), 61)
  assert.equal(majorFromBuildFile('// nothing', '<project/>'), null)
})

// ── 초안에 넣기 ──

const base: Target = {
  id: 'app',
  label: 'App',
  repo: 'C:/work/repos/app',
  mainBranch: 'main',
  runs: 'C:/work/runs/app',
  connection: { protocol: 'ftp', host: 'ftp.example.com', root: '/webapps/ROOT' },
  mappings: [{ local: 'src/main/webapp', remote: '/' }],
  manual: []
}
const sug: Suggestion = {
  mainBranch: 'master',
  mappings: [
    { local: 'WebContent', remote: '/' },
    { local: 'build/classes/java/main', remote: '/WEB-INF/classes' }
  ],
  java: { source: 'src/main/java', output: 'build/classes/java/main', major: 52, build: '.\\gradlew.bat classes' },
  majorFrom: 'class',
  manual: [{ pattern: 'WebContent/WEB-INF/web.xml', reason: '운영 서버가 별도 파일을 씀' }],
  sourceExtras: { count: 0, samples: [] }
}
const has = (dirs: string[]) => (rel: string) => dirs.includes(rel)

test('넣기(새 대상의 빈 초안): 저장소에 없는 기본 매핑을 빼고, 제안을 넣고, main 브랜치를 맞춘다', () => {
  const { target, notes } = mergeSuggestion(base, sug, { tidy: true, exists: has(['WebContent', 'src/main/java']) })
  assert.deepEqual(target.mappings, sug.mappings)
  assert.deepEqual(target.java, sug.java)
  assert.deepEqual(target.manual, sug.manual)
  assert.equal(target.mainBranch, 'master')
  assert.ok(notes.some((n) => n.includes('저장소에 없는 폴더의 기본 경로 매핑을 뺐습니다: src/main/webapp')), JSON.stringify(notes))
  assert.ok(notes.some((n) => n.includes('Java 8(빌드된 class 에서 읽음)')))
  assert.ok(notes.some((n) => n.includes('.\\gradlew.bat classes')))
  // 받은 것을 고치지 않는다
  assert.deepEqual(base.mappings, [{ local: 'src/main/webapp', remote: '/' }])
})

test('넣기(쓰고 있는 설정): 있는 값은 바꾸지 않고 빠진 것만 넣으며, 다른 점은 알려 주기만 한다', () => {
  const mine: Target = {
    ...base,
    mainBranch: 'release',
    mappings: [
      { local: 'WebContent', remote: '/app' },
      { local: 'old/folder', remote: '/old' },
      { local: 'out/classes', remote: '/WEB-INF/classes' }
    ],
    java: { source: 'src', output: 'out/classes', major: 61 },
    manual: [{ pattern: 'WebContent/WEB-INF/web.xml', reason: '내가 쓴 이유' }]
  }
  const { target, notes } = mergeSuggestion(mine, sug, { tidy: false, exists: has(['WebContent']) })
  assert.equal(target.mainBranch, 'release')
  assert.deepEqual(target.mappings.slice(0, 3), mine.mappings, '있던 매핑은 순서도 값도 그대로')
  assert.deepEqual(target.mappings[3], { local: 'build/classes/java/main', remote: '/WEB-INF/classes' })
  assert.deepEqual(target.java, { source: 'src', output: 'out/classes', major: 61, build: '.\\gradlew.bat classes' }, '비어 있던 빌드 명령만 채운다')
  assert.deepEqual(target.manual, mine.manual, '같은 패턴의 규칙은 다시 넣지 않고 이유도 그대로')
  const all = notes.join('\n')
  assert.match(all, /경로 매핑 WebContent → \/app 은 그대로 뒀습니다/)
  assert.match(all, /저장소에 없는 폴더를 가리키는 경로 매핑이 있습니다\(그대로 둠\): old\/folder/)
  assert.doesNotMatch(all, /out\/classes,|: out\/classes$/m, '빌드 결과 폴더는 빌드 전이면 없는 것이 정상')
  assert.match(all, /Java 소스·결과 폴더는 그대로 뒀습니다/)
  assert.match(all, /빌드된 class 는 Java 8\(major 52\)인데 설정은 major 61/)
  assert.match(all, /저장소의 기본 브랜치는 master 인데 설정의 main 브랜치는 release/)
})

test('넣기: 저장소 구조와 이미 맞으면 바꾸는 것도 알릴 것도 없다', () => {
  const done = mergeSuggestion(base, sug, { tidy: true, exists: has(['WebContent']) }).target
  const again = mergeSuggestion(done, sug, { tidy: false, exists: has(['WebContent']) })
  assert.deepEqual(again.target, done)
  assert.deepEqual(again.notes, [])
})

test('넣기: 화면 폴더도 Java 도 찾지 못하면 그렇게 알려 준다', () => {
  const nothing: Suggestion = { mainBranch: null, mappings: [], java: null, majorFrom: null, manual: [], sourceExtras: { count: 0, samples: [] } }
  const { target, notes } = mergeSuggestion(base, nothing, { tidy: false, exists: () => true })
  assert.deepEqual(target.mappings, base.mappings)
  assert.ok(notes.some((n) => n.includes('Java 빌드 출력은 넣지 않았습니다')))
  assert.ok(notes.some((n) => n.includes('화면 폴더')))
})

test('isDir: 폴더만 참', () => {
  assert.equal(isDir(tmp), true)
  assert.equal(isDir(`${tmp}/gradle/build.gradle`), false)
  assert.equal(isDir(`${tmp}/nope`), false)
})

test('넣기(새 대상): 사람이 고친 값은 건드리지 않는다 — 직접 정한 main 브랜치, 직접 넣은 매핑', () => {
  const edited: Target = {
    ...base,
    mainBranch: 'release',
    mappings: [
      { local: 'src/main/webapp', remote: '/app' },
      { local: 'gen/later', remote: '/gen' }
    ]
  }
  const { target, notes } = mergeSuggestion(edited, sug, { tidy: true, exists: has(['WebContent']) })
  assert.equal(target.mainBranch, 'release', '기본값(main)이 아니면 저장소의 기본 브랜치로 덮지 않는다')
  assert.deepEqual(target.mappings.slice(0, 2), edited.mappings, '기본값 그대로가 아닌 매핑은 폴더가 없어도 빼지 않는다')
  const all = notes.join('\n')
  assert.match(all, /그대로 둠\): src\/main\/webapp, gen\/later/)
  assert.match(all, /저장소의 기본 브랜치는 master 인데 설정의 main 브랜치는 release/)
  // 다시 눌러도 같다
  const again = mergeSuggestion(target, sug, { tidy: true, exists: has(['WebContent']) })
  assert.deepEqual(again.target, target)
})

test('넣기: 위 폴더의 매핑이 이미 그 폴더를 다른 곳으로 잇고 있으면 새 매핑을 넣지 않는다 — 넣으면 반영 위치가 바뀐다', () => {
  const custom: Target = { ...base, mappings: [{ local: 'WebContent', remote: '/' }, { local: 'build/classes', remote: '/custom' }] }
  const { target, notes } = mergeSuggestion(custom, sug, { tidy: false, exists: () => true })
  assert.deepEqual(target.mappings, custom.mappings)
  assert.ok(
    notes.some((n) => n.includes('build/classes/java/main 은 이미 경로 매핑 build/classes → /custom 로 운영의 /custom/java/main 에 이어져 있어')),
    JSON.stringify(notes)
  )
  // 위 폴더의 매핑으로 이미 같은 곳에 이어져 있으면 넣지도 알리지도 않는다
  const viaParent: Target = { ...base, mappings: [{ local: 'WebContent', remote: '/' }, { local: 'build/classes', remote: '/WEB-INF/x' }] }
  const one: Suggestion = { ...sug, mappings: [{ local: 'build/classes/java/main', remote: '/WEB-INF/x/java/main' }] }
  const r = mergeSuggestion(viaParent, one, { tidy: false, exists: () => true })
  assert.deepEqual(r.target.mappings, viaParent.mappings)
  assert.equal(r.notes.some((n) => n.includes('이어져 있어')), false, JSON.stringify(r.notes))
})

test('넣기: 빌드 파일에서 읽은 Java 버전이 설정과 다르면 알려 주기만 한다', () => {
  const mine: Target = { ...base, mappings: sug.mappings, java: { source: 'src/main/java', output: 'build/classes/java/main', major: 61, build: 'x' } }
  const { target, notes } = mergeSuggestion(mine, { ...sug, majorFrom: 'build-file' }, { tidy: false, exists: () => true })
  assert.equal(target.java!.major, 61)
  assert.ok(notes.some((n) => n.includes('빌드 파일에는 Java 8(major 52)로 적혀 있는데 설정은 major 61')), JSON.stringify(notes))
})

test('빌드 파일의 주석에 적힌 Java 버전은 읽지 않는다', () => {
  assert.equal(majorFromBuildFile("// targetCompatibility = '1.8'\n/* sourceCompatibility = 11 */\ntargetCompatibility = 17\n", ''), 61)
  assert.equal(majorFromBuildFile('', '<!-- <maven.compiler.target>1.8</maven.compiler.target> -->\n<maven.compiler.target>11</maven.compiler.target>'), 55)
  assert.equal(majorFromBuildFile("// targetCompatibility = '1.8'\nrepositories { maven { url 'https://example.com/repo' } }\n", ''), null)
})

test('class 를 찾을 때 링크는 따라가지 않고, class 가 아닌 파일은 건너뛴다', async () => {
  const elsewhere = `${tmp}/elsewhere`
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(`${elsewhere}/Out.class`, makeClass('Out', [], 'out', { major: 61 }))
  const root = repoWith('linked', { ...gradleWar, 'build/classes/java/main/Fake.class': 'not a class file' })
  let linked = true
  try {
    symlinkSync(elsewhere, `${root}/build/classes/java/main/link`, 'junction')
  } catch {
    linked = false
  }
  const s = await suggestFromRepo(root)
  assert.equal(s.majorFrom, 'build-file', `링크 너머(${linked ? '만듦' : '못 만듦'})의 class 나 가짜 class 를 근거로 삼지 않는다`)
  assert.equal(s.java!.major, 52)
})

test('추적하지 않는 파일은 소스 폴더의 다른 파일로 치지 않는다', async () => {
  const root = repoWith('untracked', gradleWar)
  writeFileSync(`${root}/src/main/java/com/x/notes.txt`, 'memo\n')
  const s = await suggestFromRepo(root)
  assert.equal(s.sourceExtras.count, 0)
  assert.equal(s.mappings.length, 2)
})
