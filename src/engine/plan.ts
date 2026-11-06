// 준비 확인과 plan. plan 은 운영을 읽기만 한다(목록·내려받기).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Ftp, resolveAuth } from './ftp.ts'
import {
  changedFiles,
  deployNotes,
  git,
  gitOk,
  gitText,
  revParse,
  showFile,
  viewPr,
  type Change
} from './git.ts'
import { newRun, type Run } from './runs.ts'
import {
  cleanLocal,
  gitRemote,
  inAnyMapping,
  mainBranch,
  manualReason,
  remotePathOf,
  type Target
} from './target.ts'
import { sameBytes, sameIgnoringCR, sha256, shaFile, stamp, Stop, toMsys, toNative } from './util.ts'

export type Spec = { kind: 'pr'; pr: number } | { kind: 'commit'; rev: string } | { kind: 'range'; base: string; tip: string }

/** `#123`·`123` → PR, `a..b` → 연속 구간, 나머지 → 커밋. */
export function parseSpec(s: string): Spec {
  const v = s.trim()
  if (!v) throw new Stop('PR 번호 또는 커밋이 필요함')
  const pr = /^(?:#|pr\s*)?(\d{1,6})$/i.exec(v)
  if (pr) return { kind: 'pr', pr: +pr[1] }
  if (v.includes('..')) {
    const [base, tip] = v.split(/\.\.\.?/)
    if (!base || !tip) throw new Stop(`구간이 잘못됨: ${v} (기준..끝)`)
    return { kind: 'range', base, tip }
  }
  return { kind: 'commit', rev: v }
}

export type PrInfo = { number: number; title: string; url: string; notes: string | null }
export type CheckItem = { id: string; ok: boolean; title: string; detail: string[]; fix?: string }
export type Resolved = { base: string; tip: string; head: string; subject: string; pr: PrInfo | null }
export type Preflight = { ok: boolean; items: CheckItem[]; resolved: Resolved | null; changes: Change[] }

const short = (h: string) => h.slice(0, 8)

/** 업로드할 수 있는 상태인지: 병합됨, 메인 체크아웃이 main 이고 pull 됨, 바뀐 Java 가 main 소스로 빌드됨, 커밋 안 한 수정 없음. */
export async function preflight(t: Target, specText: string, opts: { fetch?: boolean } = {}): Promise<Preflight> {
  const spec = parseSpec(specText)
  const repo = t.repo
  const branchName = mainBranch(t)
  const upstream = `${gitRemote(t)}/${branchName}`
  const items: CheckItem[] = []
  if (!existsSync(toNative(repo))) throw new Stop(`메인 체크아웃이 없음: ${repo}`)

  let fetchNote: string | null = null
  if (opts.fetch !== false) {
    const f = await git(repo, ['fetch', '--quiet', gitRemote(t), branchName])
    if (f.code !== 0) fetchNote = `git fetch 실패 — ${upstream} 와 비교한 결과가 오래됐을 수 있음: ${f.err.trim().split('\n')[0]}`
  }

  // 1. 병합됐는가 → 반영 커밋
  let tip: string | null = null
  let base: string | null = null
  let pr: PrInfo | null = null
  const merged: CheckItem = { id: 'merged', ok: false, title: '병합됨', detail: [] }
  items.push(merged)
  try {
    if (spec.kind === 'pr') {
      const p = await viewPr(repo, spec.pr)
      pr = { number: p.number, title: p.title, url: p.url, notes: deployNotes(p.body) }
      merged.title = `PR #${p.number} 병합됨`
      if (p.state !== 'MERGED' || !p.mergeCommit) merged.detail.push(`아직 병합 전 (상태 ${p.state})`)
      else {
        tip = (await revParse(repo, p.mergeCommit)) ?? null
        if (!tip) merged.detail.push(`병합 커밋 ${short(p.mergeCommit)} 이 메인 체크아웃에 없음 — main pull 필요`)
      }
    } else {
      const tipRev = spec.kind === 'range' ? spec.tip : spec.rev
      tip = await revParse(repo, tipRev)
      if (!tip) merged.detail.push(`커밋 없음: ${tipRev} — main pull 필요?`)
      if (spec.kind === 'range') {
        base = await revParse(repo, spec.base)
        if (!base) merged.detail.push(`기준 커밋 없음: ${spec.base}`)
      }
    }
    if (tip && (await revParse(repo, upstream)) && !(await gitOk(repo, ['merge-base', '--is-ancestor', tip, upstream])))
      merged.detail.push(`${short(tip)} 이 ${upstream} 에 없음 — main 에 병합된 커밋만 반영`)
    if (tip && !base) {
      base = await revParse(repo, `${tip}^`)
      if (!base) merged.detail.push('반영 커밋의 직전 커밋이 없음')
    }
  } catch (e) {
    merged.detail.push((e as Error).message)
  }
  merged.ok = !!tip && !!base && merged.detail.length === 0

  // 2. 메인 체크아웃이 main 브랜치인가
  const current = await gitText(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '?')
  items.push({
    id: 'branch',
    ok: current === branchName,
    title: `메인 체크아웃이 ${branchName} 브랜치`,
    detail: current === branchName ? [] : [`지금 ${current} — ${branchName} 으로 바꾸세요`],
    fix: current === branchName ? undefined : `git -C "${repo}" switch ${branchName}`
  })

  // 3. main pull 이 됐는가
  const head = await gitText(repo, ['rev-parse', 'HEAD'])
  const pulled: CheckItem = { id: 'pulled', ok: true, title: `${branchName} pull 됨`, detail: [] }
  if (fetchNote) pulled.detail.push(fetchNote)
  if (tip && !(await gitOk(repo, ['merge-base', '--is-ancestor', tip, 'HEAD']))) {
    pulled.ok = false
    pulled.detail.push(`반영 커밋 ${short(tip)} 이 메인 체크아웃 HEAD(${short(head)})에 없음`)
  }
  if (await revParse(repo, upstream)) {
    const behind = +(await gitText(repo, ['rev-list', '--count', `HEAD..${upstream}`]).catch(() => '0'))
    if (behind > 0) {
      pulled.ok = false
      pulled.detail.push(`${upstream} 보다 ${behind}커밋 뒤`)
    }
  }
  if (!pulled.ok) pulled.fix = `git -C "${repo}" pull --ff-only`
  items.push(pulled)

  let changes: Change[] = []
  let subject = ''
  if (tip && base) {
    changes = await changedFiles(repo, base, tip)
    subject = await gitText(repo, ['log', '-1', '--format=%h %s', tip])

    // 4. 커밋 안 한 수정이 없는가 (올릴 수 있는 파일만)
    const watched = changes.filter((c) => c.status !== 'D' && !manualReason(t, c.path) && inAnyMapping(t, c.path))
    const dirty = await dirtyPaths(repo, watched.map((c) => c.path))
    items.push({
      id: 'clean',
      ok: dirty.length === 0,
      title: '바뀐 파일에 커밋 안 한 수정 없음',
      detail: dirty.map((p) => `커밋 안 한 수정: ${p}`)
    })

    // 5. 바뀐 Java 가 main 소스로 빌드됐는가
    if (t.java) {
      const javas = javaChanges(t, changes)
      if (javas.length) {
        const detail: string[] = []
        for (const path of javas) {
          const c = classFilesOf(t, path)
          const outer = c.files.find((x) => x.outer)
          if (!outer) {
            detail.push(`class 없음: ${c.expected}`)
            continue
          }
          if (outer.mtime < c.sourceMtime) detail.push(`class 가 소스보다 오래됨: ${outer.rel}`)
          if (outer.major !== t.java.major) detail.push(`class major ${outer.major} (${t.java.major} 아님): ${outer.rel}`)
        }
        items.push({
          id: 'build',
          ok: detail.length === 0,
          title: `바뀐 Java ${javas.length}개가 main 소스로 빌드됨`,
          detail,
          fix: detail.length ? t.java.build : undefined
        })
      }
    }
  }
  return {
    ok: items.every((i) => i.ok),
    items,
    resolved: tip && base ? { base, tip, head, subject, pr } : null,
    changes
  }
}

async function dirtyPaths(repo: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return []
  const r = await git(repo, ['status', '--porcelain', '-z', '--', ...paths])
  return r.out
    .toString('utf8')
    .split('\0')
    .filter((s) => s.length > 3)
    .map((s) => s.slice(3))
}

function javaChanges(t: Target, changes: Change[]): string[] {
  if (!t.java) return []
  const src = cleanLocal(t.java.source) + '/'
  return changes
    .filter((c) => c.status !== 'D' && c.path.startsWith(src) && c.path.endsWith('.java') && !manualReason(t, c.path))
    .map((c) => c.path)
}

export type ClassFile = { rel: string; abs: string; outer: boolean; mtime: number; major: number }

/** 바뀐 .java 하나의 빌드 결과: 바깥 class 와 내부 class($*.class). */
export function classFilesOf(t: Target, javaPath: string): { files: ClassFile[]; expected: string; sourceMtime: number } {
  const java = t.java!
  const src = cleanLocal(java.source)
  const out = cleanLocal(java.output)
  const rel = javaPath.slice(src.length + 1, -'.java'.length)
  const slash = rel.lastIndexOf('/')
  const relDir = slash < 0 ? '' : rel.slice(0, slash)
  const base = slash < 0 ? rel : rel.slice(slash + 1)
  const dirRel = relDir ? `${out}/${relDir}` : out
  const dirAbs = join(toNative(t.repo), dirRel)
  const sourceMtime = statSync(join(toNative(t.repo), javaPath)).mtimeMs
  const names = existsSync(dirAbs)
    ? readdirSync(dirAbs)
        .filter((n) => n === `${base}.class` || (n.startsWith(`${base}$`) && n.endsWith('.class')))
        .sort((a, b) => (a === `${base}.class` ? -1 : b === `${base}.class` ? 1 : a < b ? -1 : a > b ? 1 : 0))
    : []
  const files: ClassFile[] = names.map((n) => {
    const abs = join(dirAbs, n)
    const head = readFileSync(abs).subarray(0, 8)
    const major = head.length === 8 && head.readUInt32BE(0) === 0xcafebabe ? head.readUInt16BE(6) : -1
    return { rel: `${dirRel}/${n}`, abs, outer: n === `${base}.class`, mtime: statSync(abs).mtimeMs, major }
  })
  return { files, expected: `${dirRel}/${base}.class`, sourceMtime }
}

type Ctx = {
  t: Target
  run: Run
  tip: string
  base: string
  targets: { local: string; remote: string; path: string }[]
}

const diffQuiet = (repo: string, a: string[], path: string) => gitOk(repo, ['diff', '--quiet', ...a, '--', path])

async function classify(ctx: Ctx, ch: Change): Promise<void> {
  const { t, run } = ctx
  const repo = t.repo
  const path = ch.path
  const why = manualReason(t, path)
  if (why) return run.append('manual.tsv', `${path}\t${why}\n`)
  if (ch.status === 'D') {
    if (inAnyMapping(t, path)) return run.append('manual.tsv', `${path}\t삭제된 파일 — 운영에서 지울지 손으로\n`)
    return run.append('skip.tsv', `${path}\t매핑 밖 파일\n`)
  }
  const err = (s: string) => run.append('errors.txt', s + '\n')
  const msysRepo = toMsys(repo)
  if (t.java && path.startsWith(cleanLocal(t.java.source) + '/') && path.endsWith('.java')) {
    if (!(await diffQuiet(repo, [ctx.tip, 'HEAD'], path))) return err(`main 에 이후 변경 있음: ${path}`)
    if (!(await diffQuiet(repo, ['HEAD'], path))) return err(`메인 체크아웃에 커밋 안 한 수정 있음(그 상태로 컴파일됨): ${path}`)
    const c = classFilesOf(t, path)
    const outer = c.files.find((x) => x.outer)
    if (!outer) return err(`class 없음(메인 체크아웃에서 빌드 필요): ${msysRepo}/${c.expected}`)
    for (const f of c.files) {
      const local = `${msysRepo}/${f.rel}`
      if (f.mtime < c.sourceMtime) {
        if (f.outer) err(`class 가 소스보다 오래됨(다시 빌드): ${local}`)
        else run.append('notes.tsv', `${f.rel}\t빌드 폴더의 옛 내부 클래스 — 올리지 않음\n`)
        if (!f.outer) continue
      }
      if (f.major !== t.java.major) err(`class major ${f.major} (${t.java.major} 아님): ${local}`)
      const remote = remotePathOf(t, f.rel)
      if (!remote) {
        err(`class 를 운영에 잇는 매핑 없음: ${f.rel}`)
        continue
      }
      ctx.targets.push({ local, remote, path: 'class' })
    }
    return
  }
  const remote = remotePathOf(t, path)
  if (!remote) return run.append('skip.tsv', `${path}\t매핑 밖 파일\n`)
  if (!(await diffQuiet(repo, [ctx.tip, 'HEAD'], path))) return err(`main 에 이후 변경 있음(HEAD 파일 ≠ 반영 커밋): ${path}`)
  if (!(await diffQuiet(repo, ['HEAD'], path))) return err(`메인 체크아웃에 커밋 안 한 수정 있음: ${path}`)
  ctx.targets.push({ local: `${msysRepo}/${path}`, remote, path })
}

export type PlanResult = { preflight: Preflight; run: Run | null; code: string | null }

/**
 * 준비 확인 → run 만들기 → 바뀐 파일 분류 → 운영 현재 상태 대조. 문제가 있으면 run 은 막힌 채로 남는다.
 * `say` 는 사람에게 보여 줄 진행 줄(로그에도 남는다).
 */
export async function plan(
  t: Target,
  specText: string,
  say: (line: string) => void = () => {},
  progress: (n: number, total: number) => void = () => {},
  onRun: (id: string) => void = () => {}
): Promise<PlanResult> {
  const pf = await preflight(t, specText)
  if (!pf.ok || !pf.resolved) return { preflight: pf, run: null, code: null }
  const { base, tip, head, subject, pr } = pf.resolved
  const run = newRun(t, `${t.id}-${stamp()}-${short(tip)}`)
  onRun(run.id)
  const log = (s: string) => {
    run.log(s)
    say(s)
  }
  run.write('meta.env', `RUN_TARGET=${t.id}\nBASE=${base}\nTIP=${tip}\nHEADC=${head}\n`)
  run.write('target.json', JSON.stringify(t, null, 2) + '\n')
  if (pr) run.write('pr.json', JSON.stringify(pr, null, 2) + '\n')
  for (const f of ['targets.tsv', 'manual.tsv', 'skip.tsv', 'errors.txt', 'plan.tsv', 'notes.tsv']) run.write(f, '')
  const c = t.connection
  log(`대상: ${t.label} → ftp://${c.host}${c.port && c.port !== 21 ? ':' + c.port : ''}${c.root}`)
  log(`plan: ${subject} (기준 ${short(base)}, HEAD ${short(head)})`)

  try {
    const ctx: Ctx = { t, run, tip, base, targets: [] }
    for (const ch of pf.changes) await classify(ctx, ch)
    run.write('targets.tsv', ctx.targets.map((x) => `${x.local}\t${x.remote}\t${x.path}\n`).join(''))

    const ftp = new Ftp(t, await resolveAuth(t), (s) => run.log(s))
    let n = 0
    // 반영 목록은 다 모은 뒤 한 번에 쓴다: 중간에 끊긴 plan 의 반쪽 목록이 남지 않게.
    const lines: string[] = []
    for (const x of ctx.targets) {
      progress(++n, ctx.targets.length)
      const lsha = shaFile(x.local)
      if (!(await ftp.exists(x.remote))) {
        lines.push(`A\t${x.local}\t${x.remote}\t${lsha}\t-\t\n`)
        continue
      }
      const r = await ftp.read(x.remote)
      if (!r) {
        run.append('errors.txt', `운영 파일 받기 실패: ${x.remote}\n`)
        continue
      }
      let note = ''
      if (x.path !== 'class') {
        const atTip = (await showFile(t.repo, tip, x.path)) ?? Buffer.alloc(0)
        const atBase = await showFile(t.repo, base, x.path)
        if (sameIgnoringCR(r, atTip)) run.append('errors.txt', `운영본이 이미 반영 커밋 내용과 같음(이미 반영됨?): ${x.remote}\n`)
        else if (atBase) {
          if (!sameBytes(r, atBase)) {
            if (sameIgnoringCR(r, atBase)) note = '운영본과 직전 커밋은 개행만 다름'
            else run.append('errors.txt', `운영본이 직전 커밋과 다름(운영에만 있는 수정?): ${x.remote}\n`)
          }
        } else run.append('errors.txt', `저장소엔 새 파일인데 운영에 이미 있음: ${x.remote}\n`)
      } else note = 'class 는 운영본 대조 생략'
      lines.push(`M\t${x.local}\t${x.remote}\t${lsha}\t${sha256(r)}\t${note}\n`)
    }
    run.write('plan.tsv', lines.join(''))
  } catch (e) {
    // 중간에 끊긴 plan 은 반쯤 만든 반영 목록이 정상으로 보이지 않도록 막힌 run 으로 남긴다.
    run.append('errors.txt', `plan 중단: ${(e as Error).message}\n`)
    log(`멈춤: plan 중단 — ${(e as Error).message}`)
    run.write('plan.done', new Date().toISOString() + '\n')
    return { preflight: pf, run, code: null }
  }
  // plan.done 이 없으면 run 은 막힌 것으로 본다(프로세스가 강제로 끝난 경우).
  run.write('plan.done', new Date().toISOString() + '\n')

  const errors = run.errors()
  const rows = run.plan()
  if (errors.length) {
    log(`멈춤: plan 에 문제 ${errors.length}건`)
    return { preflight: pf, run, code: null }
  }
  if (!rows.length) {
    log('멈춤: 올릴 파일 없음')
    return { preflight: pf, run, code: null }
  }
  const code = run.code()
  log(`plan 완료: ${rows.length}개, 코드 ${code}`)
  return { preflight: pf, run, code }
}
