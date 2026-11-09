// 처음부터 끝까지: 임시 저장소 + 시험 FTP(pyftpdlib)로 check → plan → backup → upload → verify → rollback
// 과 막아야 할 경우들을 CLI 그대로 돌려 본다. 운영·자격 증명 관리자는 건드리지 않는다(접속은 임시 netrc).
//
// 사용법: node test/e2e.ts            (pyftpdlib venv: ~/.prod-deploy/test-ftp/venv)
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClass, type FixField } from './class-fixture.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli.ts')
const PY = join(homedir(), '.prod-deploy', 'test-ftp', 'venv', 'Scripts', 'python.exe')
const PORT = 2199
const tmp = mkdtempSync(join(tmpdir(), 'pd-e2e-')).replace(/\\/g, '/')
const HOME = `${tmp}/home`
const repo = `${tmp}/repo`
const ftpRoot = `${tmp}/ftp`
const env = { ...process.env, PRODDEPLOY_HOME: HOME }
// 엔진을 이 프로세스에서 직접 부르는 시험(고정본)도 같은 임시 홈을 쓴다.
process.env.PRODDEPLOY_HOME = HOME

let failures = 0
async function step(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`✔ ${name}`)
  } catch (e) {
    failures++
    console.log(`✘ ${name}\n${String((e as Error).message).replace(/^/gm, '    ')}`)
  }
}

function sh(cwd: string, cmd: string, ...args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const gitc = (...a: string[]) => sh(repo, 'git', ...a)

function write(path: string, text: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** major 52 인 시험용 class 파일. tag 로 어느 파일인지 구분한다. */
function classBytes(tag: string, name = 'com/x/Foo', fields: FixField[] = []): Buffer {
  return makeClass(name, fields, tag)
}
const hasTag = (p: string, tag: string) => ftpText(p)?.includes(tag) ?? false

function cli(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const runOf = (out: string) => /run: (\S+)/.exec(out)?.[1] ?? ''
const codeOf = (out: string) => /확인 코드: ([0-9a-f]{8})/.exec(out)?.[1] ?? ''
const ftpFile = (p: string) => join(ftpRoot, 'app', p)
const ftpText = (p: string) => (existsSync(ftpFile(p)) ? readFileSync(ftpFile(p), 'utf8') : null)

const W = 'src/main/webapp'
const C = 'build/classes/java/main/com/x'

async function main(): Promise<void> {
  if (!existsSync(PY)) throw new Error(`pyftpdlib venv 없음: ${PY}`)

  // ── 저장소: 원격(bare) + 메인 체크아웃 ──
  sh(tmp, 'git', 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  sh(tmp, 'git', 'clone', '-q', `${tmp}/origin.git`, 'repo')
  gitc('config', 'user.name', 'e2e')
  gitc('config', 'user.email', 'e2e@example.invalid')
  gitc('config', 'core.autocrlf', 'false')
  gitc('checkout', '-q', '-b', 'main')
  write(`${repo}/.gitignore`, 'build/\n')
  write(`${repo}/${W}/ui/a.xml`, '<a>base</a>\n')
  write(`${repo}/${W}/ui/b.js`, 'var b = 1\n')
  write(`${repo}/${W}/WEB-INF/web.xml`, '<web/>\n')
  // 운영 루트의 new-files.txt: 백업 메타데이터(backup/new-files.txt)와 이름이 겹쳐도 백업이 덮이지 않아야 한다.
  write(`${repo}/${W}/new-files.txt`, 'base list\n')
  write(`${repo}/src/main/java/com/x/Foo.java`, 'class Foo {}\n')
  write(`${repo}/README.md`, 'readme\n')
  gitc('add', '-A')
  gitc('commit', '-q', '-m', 'base')
  gitc('push', '-q', '-u', 'origin', 'main')

  // 운영(시험 FTP) = base 상태
  write(ftpFile('ui/a.xml'), '<a>base</a>\n')
  write(ftpFile('ui/b.js'), 'var b = 1\n')
  write(ftpFile('WEB-INF/web.xml'), '<web prod/>\n')
  write(ftpFile('new-files.txt'), 'base list\n')
  write(ftpFile('WEB-INF/classes/com/x/Foo.class'), classBytes('foo-base'))

  // 반영 커밋: 고침·새 파일·지움·손 처리·매핑 밖·Java
  write(`${repo}/${W}/ui/a.xml`, '<a>tip</a>\n')
  write(`${repo}/${W}/ui/c.html`, '<p>new</p>\n')
  rmSync(`${repo}/${W}/ui/b.js`)
  write(`${repo}/${W}/WEB-INF/web.xml`, '<web changed/>\n')
  write(`${repo}/${W}/new-files.txt`, 'tip list\n')
  write(`${repo}/README.md`, 'readme 2\n')
  write(`${repo}/src/main/java/com/x/Foo.java`, 'class Foo { Runnable r = new Runnable() { public void run() {} }; }\n')
  gitc('add', '-A')
  gitc('commit', '-q', '-m', 'tip: 반영할 변경')
  gitc('push', '-q')
  const tip1 = gitc('rev-parse', 'HEAD')
  // 빌드: 바깥·익명 class 는 소스보다 새것, 옛 내부 class 는 소스보다 오래된 찌꺼기
  const now = Date.now() / 1000
  write(`${repo}/${C}/Foo.class`, classBytes('foo-tip'))
  write(`${repo}/${C}/Foo$1.class`, makeClass('com/x/Foo$1', [], 'foo-anon', { sourceFile: 'Foo.java' }))
  write(`${repo}/${C}/Foo$Old.class`, makeClass('com/x/Foo$Old', [], 'foo-old', { sourceFile: 'Foo.java' }))
  utimesSync(`${repo}/src/main/java/com/x/Foo.java`, now - 60, now - 60)
  utimesSync(`${repo}/${C}/Foo$Old.class`, now - 3600, now - 3600)

  // ── 대상 설정 ──
  write(`${tmp}/netrc`, `machine 127.0.0.1 login test password test\n`)
  write(
    `${HOME}/targets/fx.json`,
    JSON.stringify({
      id: 'fx',
      label: 'FX (e2e)',
      test: true,
      repo,
      runs: `${tmp}/runs`,
      connection: { protocol: 'ftp', host: '127.0.0.1', port: PORT, root: '/app', passive: true },
      legacyNetrc: `${tmp}/netrc`,
      mappings: [
        { local: W, remote: '/' },
        { local: 'build/classes/java/main', remote: '/WEB-INF/classes' }
      ],
      java: { source: 'src/main/java', output: 'build/classes/java/main', major: 52, build: 'gradlew classes' },
      manual: [{ pattern: `${W}/WEB-INF/web.xml`, reason: '운영 서버가 별도 파일을 씀' }]
    })
  )

  // ── 시험 FTP ──
  // 서버 출력은 파일로 바로: 파이프로 받으면 spawnSync 동안 못 읽어 파이프가 차고 서버가 멈춘다.
  const logFile = `${tmp}/ftp-server.log`
  const fd = openSync(logFile, 'w')
  const server = spawn(PY, ['-I', join(ROOT, 'test', 'ftp-server.py'), ftpRoot, String(PORT)], { stdio: ['ignore', fd, fd] })
  let exited: number | null = null
  server.on('exit', (c) => (exited = c ?? -1))
  for (let i = 0; ; i++) {
    if (readFileSync(logFile, 'utf8').includes('ready')) break
    if (exited !== null) throw new Error(`시험 FTP 종료 ${exited}: ${readFileSync(logFile, 'utf8')}`)
    if (i > 150) throw new Error('시험 FTP 가 뜨지 않음')
    await new Promise((r) => setTimeout(r, 100))
  }

  try {
    await scenarios(tip1)
  } finally {
    server.kill()
  }
}

async function scenarios(tip1: string): Promise<void> {
  let run = ''
  let code = ''

  await step('준비 확인 통과', () => {
    const r = cli('check', '--target', 'fx', tip1)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /✔ 바뀐 Java 1개가 main 소스로 빌드됨/)
  })

  await step('plan: 반영 목록·손 처리·매핑 밖·옛 내부 클래스', () => {
    const r = cli('plan', '--target', 'fx', tip1)
    assert.equal(r.code, 0, r.out)
    run = runOf(r.out)
    code = codeOf(r.out)
    assert.ok(run.startsWith('fx-') && code, r.out)
    assert.match(r.out, /덮어씀\tsrc\/main\/webapp\/ui\/a\.xml\t→ \/app\/ui\/a\.xml/)
    assert.match(r.out, /새파일\tsrc\/main\/webapp\/ui\/c\.html\t→ \/app\/ui\/c\.html/)
    assert.match(r.out, /덮어씀\tbuild\/classes\/java\/main\/com\/x\/Foo\.class\t→ \/app\/WEB-INF\/classes\/com\/x\/Foo\.class/)
    assert.match(r.out, /새파일\tbuild\/classes\/java\/main\/com\/x\/Foo\$1\.class/)
    assert.doesNotMatch(r.out, /(덮어씀|새파일)\t.*Foo\$Old/)
    assert.match(r.out, /Foo\$Old\.class  — 빌드 폴더의 옛 내부 클래스/)
    assert.match(r.out, /web\.xml  — 운영 서버가 별도 파일을 씀/)
    assert.match(r.out, /b\.js  — 삭제된 파일/)
    assert.match(r.out, /매핑 밖 파일 ==\nREADME\.md/)
    assert.match(r.out, /톰캣 재기동/)
  })

  await step('확인 코드가 틀리면 올리지 않음', () => {
    const r = cli('upload', run, '--plan', '00000000', '--yes')
    assert.equal(r.code, 1)
    assert.match(r.out, /확인 코드가 다름/)
  })

  await step('--yes 없으면 올리지 않음', () => {
    const r = cli('upload', run, '--plan', code)
    assert.equal(r.code, 1)
    assert.match(r.out, /--yes/)
  })

  await step('백업 전에는 올리지 않음', () => {
    const r = cli('upload', run, '--plan', code, '--yes')
    assert.equal(r.code, 1)
    assert.match(r.out, /백업 먼저/)
  })

  await step('다른 작업이 대상을 잡고 있으면 멈춤', () => {
    const lock = `${HOME}/locks/fx.lock`
    write(lock, JSON.stringify({ target: 'fx', run: 'x', step: 'upload', pid: process.pid, startedAt: 'now', by: 'e2e' }))
    const r = cli('backup', run)
    rmSync(lock)
    assert.equal(r.code, 1)
    assert.match(r.out, /다른 작업 중/)
  })

  await step('backup (운영 루트의 new-files.txt 도 메타데이터에 덮이지 않음)', () => {
    const r = cli('backup', run)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /백업 완료/)
    const b = `${tmp}/runs/${run}/backup`
    assert.equal(readFileSync(`${b}/files/new-files.txt`, 'utf8'), 'base list\n')
    assert.match(readFileSync(`${b}/new-files.txt`, 'utf8'), /\/app\/ui\/c\.html/)
  })

  await step('upload → 운영 = 반영 커밋', () => {
    const r = cli('upload', run, '--plan', code, '--yes')
    assert.equal(r.code, 0, r.out)
    assert.equal(ftpText('ui/a.xml'), '<a>tip</a>\n')
    assert.equal(ftpText('ui/c.html'), '<p>new</p>\n')
    assert.equal(ftpText('ui/b.js'), 'var b = 1\n', '지운 파일은 운영에서 지우지 않음')
    assert.equal(ftpText('WEB-INF/web.xml'), '<web prod/>\n', '손 처리 파일은 올리지 않음')
    assert.ok(hasTag('WEB-INF/classes/com/x/Foo$1.class', 'foo-anon'))
    assert.equal(existsSync(ftpFile('WEB-INF/classes/com/x/Foo$Old.class')), false)
    assert.equal(existsSync(ftpFile('ui/a.xml.uploading')), false)
  })

  await step('verify', () => {
    const r = cli('verify', run)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /운영 = 로컬 5\/5/)
  })

  await step('같은 run 은 다시 올리지 않음', () => {
    const r = cli('upload', run, '--plan', code, '--yes')
    assert.equal(r.code, 1)
    assert.match(r.out, /이미 올린 run/)
  })

  await step('반영된 커밋으로 다시 plan → 이미 반영됨', () => {
    const r = cli('plan', '--target', 'fx', tip1)
    assert.equal(r.code, 1)
    assert.match(r.out, /이미 반영됨\?\): \/app\/ui\/a\.xml/)
    assert.doesNotMatch(r.out, /확인 코드:/)
  })

  await step('rollback → 운영 = 직전 상태', () => {
    const r = cli('rollback', run, '--plan', code, '--yes')
    assert.equal(r.code, 0, r.out)
    assert.equal(ftpText('ui/a.xml'), '<a>base</a>\n')
    assert.equal(ftpText('new-files.txt'), 'base list\n')
    assert.equal(existsSync(ftpFile('ui/c.html')), false)
    assert.equal(existsSync(ftpFile('WEB-INF/classes/com/x/Foo$1.class')), false)
    assert.ok(hasTag('WEB-INF/classes/com/x/Foo.class', 'foo-base'))
  })

  await step('되돌린 run 은 다시 올리지 않음', () => {
    const r = cli('upload', run, '--plan', code, '--yes')
    assert.equal(r.code, 1)
    assert.match(r.out, /되돌린 run/)
  })

  await step('패널의 두 버튼: plan --backup 은 백업까지, upload 는 대조까지', () => {
    const p = cli('plan', '--target', 'fx', tip1, '--backup')
    assert.equal(p.code, 0, p.out)
    assert.match(p.out, /백업 완료/)
    const run2 = runOf(p.out)
    const code2 = codeOf(p.out)
    assert.match(cli('show', run2).out, /\(백업됨\)/)
    const u = cli('upload', run2, '--plan', code2, '--yes')
    assert.equal(u.code, 0, u.out)
    assert.match(u.out, /운영 = 로컬 5\/5/)
    assert.match(cli('show', run2).out, /\(대조됨\)/)
    // 다음 시나리오를 위해 직전 상태로
    assert.equal(cli('rollback', run2, '--plan', code2, '--yes').code, 0)
    assert.equal(ftpText('ui/a.xml'), '<a>base</a>\n')
  })

  await step('운영에만 있는 수정이면 막힘', () => {
    write(ftpFile('ui/a.xml'), '<a>hotfix on prod</a>\n')
    const r = cli('plan', '--target', 'fx', tip1)
    write(ftpFile('ui/a.xml'), '<a>base</a>\n')
    assert.equal(r.code, 1)
    assert.match(r.out, /운영에만 있는 수정\?\): \/app\/ui\/a\.xml/)
  })

  await step('class 가 소스보다 오래되면 준비 확인에서 막힘', () => {
    const src = `${repo}/src/main/java/com/x/Foo.java`
    const later = Date.now() / 1000 + 120
    utimesSync(src, later, later)
    const r = cli('check', '--target', 'fx', tip1)
    const p = cli('plan', '--target', 'fx', tip1)
    const t = Date.now() / 1000 - 60
    utimesSync(src, t, t)
    assert.equal(r.code, 1)
    assert.match(r.out, /✘ 바뀐 Java[\s\S]*class 가 소스보다 오래됨/)
    assert.match(r.out, /할 일: gradlew classes/)
    assert.equal(p.code, 1)
    assert.match(p.out, /준비 확인 실패/)
  })

  await step('메인 체크아웃이 main 이 아니면 막힘', () => {
    gitc('checkout', '-q', '-b', 'feature/x')
    const r = cli('check', '--target', 'fx', tip1)
    gitc('checkout', '-q', 'main')
    assert.equal(r.code, 1)
    assert.match(r.out, /✘ 메인 체크아웃이 main 브랜치\n\s+지금 feature\/x/)
  })

  await step('plan 이후 로컬 파일이 바뀌면 올리지 않음', () => {
    const p = cli('plan', '--target', 'fx', tip1)
    const r2 = runOf(p.out)
    const c2 = codeOf(p.out)
    assert.equal(cli('backup', r2).code, 0)
    const f = `${repo}/${W}/ui/a.xml`
    write(f, '<a>edited after plan</a>\n')
    const r = cli('upload', r2, '--plan', c2, '--yes')
    gitc('checkout', '--', `${W}/ui/a.xml`)
    assert.equal(r.code, 1)
    assert.match(r.out, /plan 이후 로컬 파일이 바뀜/)
    assert.equal(ftpText('ui/a.xml'), '<a>base</a>\n', '아무것도 올라가지 않음')
  })

  await step('나중 run 이 같은 파일을 올렸으면 앞 run 은 되돌리지 않음', () => {
    const pa = cli('plan', '--target', 'fx', tip1)
    const ra = runOf(pa.out)
    const ca = codeOf(pa.out)
    assert.equal(cli('backup', ra).code, 0)
    assert.equal(cli('upload', ra, '--plan', ca, '--yes').code, 0)
    write(`${repo}/${W}/ui/a.xml`, '<a>tip2</a>\n')
    gitc('commit', '-q', '-am', 'tip2')
    gitc('push', '-q')
    const tip2 = gitc('rev-parse', 'HEAD')
    const pb = cli('plan', '--target', 'fx', tip2)
    assert.equal(pb.code, 0, pb.out)
    const rb = runOf(pb.out)
    const cb = codeOf(pb.out)
    assert.equal(cli('backup', rb).code, 0)
    assert.equal(cli('upload', rb, '--plan', cb, '--yes').code, 0)
    assert.equal(ftpText('ui/a.xml'), '<a>tip2</a>\n')
    const blocked = cli('rollback', ra, '--plan', ca, '--yes')
    assert.equal(blocked.code, 1)
    assert.match(blocked.out, new RegExp(`먼저 되돌리세요: ${rb}`))
    assert.equal(cli('rollback', rb, '--plan', cb, '--yes').code, 0)
    assert.equal(ftpText('ui/a.xml'), '<a>tip</a>\n')
    assert.equal(cli('rollback', ra, '--plan', ca, '--yes').code, 0)
    assert.equal(ftpText('ui/a.xml'), '<a>base</a>\n')
  })

  // 여기부터는 HEAD(tip2) 를 반영한다: 운영 a.xml 을 tip2 의 직전(tip1) 상태로 맞춰 둔다.
  write(ftpFile('ui/a.xml'), '<a>tip</a>\n')
  const tip2 = gitc('rev-parse', 'HEAD')

  await step('다시 백업하다 실패하면 완료 표시가 지워지고 업로드가 막힘 (리뷰 #2)', () => {
    const p = cli('plan', '--target', 'fx', tip2)
    const r = runOf(p.out)
    const c = codeOf(p.out)
    assert.equal(cli('backup', r).code, 0)
    write(ftpFile('ui/a.xml'), '<a>changed between backups</a>\n')
    const again = cli('backup', r)
    write(ftpFile('ui/a.xml'), '<a>tip</a>\n')
    assert.equal(again.code, 1)
    assert.equal(existsSync(`${tmp}/runs/${r}/backup.done`), false)
    const up = cli('upload', r, '--plan', c, '--yes')
    assert.equal(up.code, 1)
    assert.match(up.out, /백업 먼저/)
  })

  await step('대상 설정이 plan 이후 바뀌면 백업·업로드가 막힘 (리뷰 #6)', () => {
    const p = cli('plan', '--target', 'fx', tip2)
    const r = runOf(p.out)
    const c = codeOf(p.out)
    assert.equal(cli('backup', r).code, 0)
    const f = `${HOME}/targets/fx.json`
    const before = readFileSync(f, 'utf8')
    const changed = JSON.parse(before)
    changed.connection.root = '/GG2'
    writeFileSync(f, JSON.stringify(changed))
    const up = cli('upload', r, '--plan', c, '--yes')
    const shown = cli('show', r, '--json')
    writeFileSync(f, before)
    assert.equal(up.code, 1)
    assert.match(up.out, /대상 설정이 plan 이후 바뀜/)
    assert.equal(JSON.parse(shown.out).configChanged, true)
    assert.equal(ftpText('ui/a.xml'), '<a>tip</a>\n')
  })

  await step('올린 뒤 운영 파일이 바뀌었으면 되돌리지 않음 (리뷰 #8)', () => {
    const p = cli('plan', '--target', 'fx', tip2)
    const r = runOf(p.out)
    const c = codeOf(p.out)
    assert.equal(cli('backup', r).code, 0)
    assert.equal(cli('upload', r, '--plan', c, '--yes').code, 0)
    write(ftpFile('ui/a.xml'), '<a>hotfix after upload</a>\n')
    const blocked = cli('rollback', r, '--plan', c, '--yes')
    assert.equal(blocked.code, 1)
    assert.match(blocked.out, /이 run 이 올린 뒤 운영 파일이 바뀜: \/app\/ui\/a\.xml/)
    assert.equal(ftpText('ui/a.xml'), '<a>hotfix after upload</a>\n', '되돌리기가 아무것도 바꾸지 않음')
    write(ftpFile('ui/a.xml'), '<a>tip2</a>\n')
    assert.equal(cli('rollback', r, '--plan', c, '--yes').code, 0)
    assert.equal(ftpText('ui/a.xml'), '<a>tip</a>\n')
  })

  // 새 파일: 있는 폴더(ui)와 없는 폴더(newdir)
  write(`${repo}/${W}/ui/d.html`, '<p>d</p>\n')
  write(`${repo}/${W}/newdir/e.html`, '<p>e</p>\n')
  gitc('add', '-A')
  gitc('commit', '-q', '-m', 'tip3: 새 파일')
  gitc('push', '-q')
  const tip3 = gitc('rev-parse', 'HEAD')

  await step('목록 권한이 거부되면 "없음"으로 보지 않고 멈춤 (리뷰 #4)', () => {
    write(`${tmp}/deny-nlst.txt`, '/app/ui\n')
    const p = cli('plan', '--target', 'fx', tip3)
    rmSync(`${tmp}/deny-nlst.txt`)
    assert.equal(p.code, 1)
    assert.match(p.out, /운영 폴더 목록을 확인할 수 없음: \/app\/ui/)
    assert.doesNotMatch(p.out, /확인 코드:/)
  })

  await step('없는 폴더의 새 파일은 위 폴더 목록으로 "없음" 확인', () => {
    const p = cli('plan', '--target', 'fx', tip3)
    assert.equal(p.code, 0, p.out)
    assert.match(p.out, /새파일\tsrc\/main\/webapp\/newdir\/e\.html\t→ \/app\/newdir\/e\.html/)
    assert.match(p.out, /새파일\tsrc\/main\/webapp\/ui\/d\.html/)
  })

  await step('업로드 도중 로컬 파일이 바뀌어도 승인한 바이트만 올라감 (리뷰 #3)', async () => {
    const { upload, backup } = await import('../src/engine/steps.ts')
    const p = cli('plan', '--target', 'fx', tip3)
    const r = runOf(p.out)
    const c = codeOf(p.out)
    await backup(r)
    const e = `${repo}/${W}/newdir/e.html`
    await upload(r, c, true, {
      say: (s) => {
        if (s.startsWith('업로드 시작')) write(e, '<p>NOT APPROVED</p>\n')
      }
    })
    gitc('checkout', '--', `${W}/newdir/e.html`)
    assert.equal(ftpText('newdir/e.html'), '<p>e</p>\n')
    assert.equal(cli('verify', r).code, 0)
    assert.equal(cli('rollback', r, '--plan', c, '--yes').code, 0)
    assert.equal(existsSync(ftpFile('newdir/e.html')), false)
    assert.equal(existsSync(ftpFile('ui/d.html')), false)
  })

  // src/main/java 아래 .java 가 아닌 파일(메일 템플릿 등): 빌드가 WEB-INF/classes 에 넣는다.
  write(`${repo}/src/main/java/com/x/mail.txt`, 'hello\n')
  gitc('add', '-A')
  gitc('commit', '-q', '-m', 'tip4: 템플릿')
  gitc('push', '-q')
  const tip4 = gitc('rev-parse', 'HEAD')

  await step('src/main 아래 매핑 밖 파일은 막힘, 매핑을 넣으면 올라감', () => {
    const blocked = cli('plan', '--target', 'fx', tip4)
    assert.equal(blocked.code, 1)
    assert.match(blocked.out, /경로 매핑·손 처리 규칙이 없음: src\/main\/java\/com\/x\/mail\.txt/)
    const f = `${HOME}/targets/fx.json`
    const before = readFileSync(f, 'utf8')
    const t = JSON.parse(before)
    t.mappings.push({ local: 'src/main/java', remote: '/WEB-INF/classes' })
    writeFileSync(f, JSON.stringify(t))
    const ok = cli('plan', '--target', 'fx', tip4)
    writeFileSync(f, before)
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /새파일\tsrc\/main\/java\/com\/x\/mail\.txt\t→ \/app\/WEB-INF\/classes\/com\/x\/mail\.txt/)
  })

  // 상수: Bar 는 Foo.LIMIT 로, User 는 Foo 를 상속한 Mid 를 상속해서 그냥 LIMIT 로 쓴다(소스에 Foo 가 없음).
  // 이 셋을 먼저 넣고, 다음 커밋에서 Foo 의 상수 값만 바꾼다. Foo.java 에는 다른 최상위 class FooHelper 도 있다.
  const J = `${repo}/src/main/java/com/x`
  write(`${J}/Bar.java`, 'class Bar { int x = Foo.LIMIT; }\n')
  write(`${J}/Mid.java`, 'class Mid extends Foo {}\n')
  write(`${J}/User.java`, 'class User extends Mid { int n = LIMIT; }\n')
  // 식을 거쳐 부름: 소스에 Foo 도, Foo 를 상속한 이름도 없다
  write(`${J}/Other.java`, 'class Other { int n = Registry.get().LIMIT; }\n')
  gitc('add', '-A')
  gitc('commit', '-q', '-m', 'tip5a: Bar, Mid, User, Other')
  const tip5a = gitc('rev-parse', 'HEAD')
  write(`${J}/Foo.java`, 'class Foo { public static final int LIMIT = 2; }\nclass FooHelper {}\n')
  gitc('commit', '-q', '-am', 'tip5: Foo.LIMIT = 2')
  gitc('push', '-q')
  const tip5 = gitc('rev-parse', 'HEAD')
  const src = (f: string) => ({ sourceFile: f })
  write(`${repo}/${C}/Foo.class`, makeClass('com/x/Foo', [{ name: 'LIMIT', desc: 'I', value: 2 }], 'foo-limit2', src('Foo.java')))
  write(`${repo}/${C}/FooHelper.class`, makeClass('com/x/FooHelper', [], 'foo-helper', src('Foo.java')))
  write(`${repo}/${C}/Bar.class`, makeClass('com/x/Bar', [], 'bar', src('Bar.java')))
  write(`${repo}/${C}/Mid.class`, makeClass('com/x/Mid', [], 'mid', { superName: 'com/x/Foo', sourceFile: 'Mid.java' }))
  write(`${repo}/${C}/User.class`, makeClass('com/x/User', [], 'user', { superName: 'com/x/Mid', sourceFile: 'User.java' }))
  write(`${repo}/${C}/Other.class`, makeClass('com/x/Other', [], 'other', src('Other.java')))
  write(ftpFile('WEB-INF/classes/com/x/Foo.class'), classBytes('foo-limit1', 'com/x/Foo', [{ name: 'LIMIT', desc: 'I', value: 1 }]))

  await step('상수 값이 바뀌었는데 이름이 나오는 소스(직접·상속·식)가 반영 목록에 없으면 경고', () => {
    const r = cli('plan', '--target', 'fx', tip5)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /== 경고 1건 \(사람이 보고 확인해야 올림: ack /)
    const line = /상수 값이 바뀜: com\.x\.Foo\.LIMIT \(1 → 2\) — 이 이름이 나오는 소스가 반영 목록에 없음: (.*?) — /.exec(r.out)
    assert.ok(line, r.out)
    assert.deepEqual(line[1].split(', ').sort(), [
      'src/main/java/com/x/Bar.java',
      'src/main/java/com/x/Other.java',
      'src/main/java/com/x/User.java'
    ])
    assert.match(r.out, /확인 코드:/)
  })

  await step('같은 .java 의 다른 최상위 class 도 반영 목록에 들어감, 출처를 모르는 class 는 막힘', () => {
    const r = cli('plan', '--target', 'fx', tip5)
    assert.match(r.out, /새파일\tbuild\/classes\/java\/main\/com\/x\/FooHelper\.class/)
    write(`${repo}/${C}/Stray.class`, makeClass('com/x/Stray', [], 'stray'))
    const stray = cli('plan', '--target', 'fx', tip5)
    rmSync(`${repo}/${C}/Stray.class`)
    assert.match(stray.out, /소스 파일 이름\(SourceFile\)이 없음[^\n]*Stray\.class/)
  })

  await step('상수를 쓰는 class 도 반영 목록에 있으면 통과', () => {
    const r = cli('plan', '--target', 'fx', `${tip5a}^..${tip5}`)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /새파일\tbuild\/classes\/java\/main\/com\/x\/Bar\.class/)
    assert.match(r.out, /새파일\tbuild\/classes\/java\/main\/com\/x\/User\.class/)
    assert.match(r.out, /새파일\tbuild\/classes\/java\/main\/com\/x\/Other\.class/)
    assert.match(r.out, /상수 LIMIT 값이 바뀜 \(1 → 2\)/)
    assert.doesNotMatch(r.out, /== 경고/)
  })

  await step('경고가 있는 run 은 사람이 확인(ack)해야 올라감', () => {
    const p = cli('plan', '--target', 'fx', tip5)
    const r = runOf(p.out)
    const c = codeOf(p.out)
    assert.equal(cli('backup', r).code, 0)
    const blocked = cli('upload', r, '--plan', c, '--yes')
    assert.equal(blocked.code, 1)
    assert.match(blocked.out, /경고 1건을 사람이 확인해야 올림/)
    assert.ok(hasTag('WEB-INF/classes/com/x/Foo.class', 'foo-limit1'), '아무것도 올라가지 않음')
    const ack = cli('ack', r, '--by', 'e2e')
    assert.equal(ack.code, 0, ack.out)
    assert.match(cli('show', r).out, /== 경고 1건 \(확인함\) ==/)
    assert.match(readFileSync(`${tmp}/runs/${r}/warnings.ack`, 'utf8'), /\te2e\t/)
    const up = cli('upload', r, '--plan', c, '--yes')
    assert.equal(up.code, 0, up.out)
    assert.ok(hasTag('WEB-INF/classes/com/x/Foo.class', 'foo-limit2'))
    // 경고 내용이 확인 뒤 바뀌면 확인은 무효(여기서는 되돌리기 전에 상태만 본다)
    writeFileSync(`${tmp}/runs/${r}/warnings.txt`, readFileSync(`${tmp}/runs/${r}/warnings.txt`, 'utf8') + 'x\n')
    assert.match(cli('show', r).out, /== 경고 2건 \(사람이 보고 확인해야 올림/)
    assert.equal(cli('ack', r).code, 1, '올린 run 은 확인할 수 없음')
    assert.equal(cli('rollback', r, '--plan', c, '--yes').code, 0)
    assert.ok(hasTag('WEB-INF/classes/com/x/Foo.class', 'foo-limit1'))
  })

  // src/main 아래 매핑 밖 파일을 지움
  write(`${repo}/src/main/extra/x.txt`, 'x\n')
  gitc('add', '-A')
  gitc('commit', '-q', '-m', 'tip6a: extra')
  rmSync(`${repo}/src/main/extra/x.txt`)
  gitc('commit', '-q', '-am', 'tip6: extra 지움')
  gitc('push', '-q')
  const tip6 = gitc('rev-parse', 'HEAD')

  await step('src/main 아래 매핑 밖 파일을 지우면 손 처리로 남김', () => {
    const r = cli('plan', '--target', 'fx', tip6)
    assert.match(r.out, /src\/main\/extra\/x\.txt  — 삭제된 파일/)
    assert.doesNotMatch(r.out, /== 매핑 밖 파일 ==\nsrc\/main\/extra/)
  })

  await step('반영 커밋 뒤에 pull 이 안 됐으면 막힘', () => {
    // 다른 곳에서 main 에 커밋이 하나 더 들어온 상황
    sh(tmp, 'git', 'clone', '-q', `${tmp}/origin.git`, 'other')
    sh(`${tmp}/other`, 'git', '-c', 'user.name=o', '-c', 'user.email=o@x.invalid', 'commit', '-q', '--allow-empty', '-m', 'other')
    sh(`${tmp}/other`, 'git', 'push', '-q')
    const r = cli('check', '--target', 'fx', 'HEAD')
    assert.equal(r.code, 1)
    assert.match(r.out, /✘ main pull 됨\n\s+origin\/main 보다 1커밋 뒤/)
  })

  await step('run 목록과 상태', () => {
    const r = cli('runs', '--target', 'fx')
    assert.equal(r.code, 0)
    assert.match(r.out, /되돌림/)
    assert.match(r.out, /막힘/)
  })
}

main().then(
  () => {
    console.log(failures ? `\n실패 ${failures}건 (임시 폴더 ${tmp})` : `\n모두 통과 (임시 폴더 ${tmp})`)
    process.exit(failures ? 1 : 0)
  },
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
