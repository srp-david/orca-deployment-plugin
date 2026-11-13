// 대상 설정: ~/.prod-deploy/targets/<id>.json. 패널·CLI·워커가 이 파일 하나를 같이 쓴다.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commonDir } from './git.ts'
import { expandHome, home, Stop, toNative } from './util.ts'

/** 저장소 폴더 하나 → 운영 루트 아래 폴더 하나 (IntelliJ Deployment 의 Mappings). */
export type Mapping = { local: string; remote: string }
/** 손 처리 규칙: 글롭 패턴에 걸리면 올리지 않고 이유를 보여 준다. */
export type ManualRule = { pattern: string; reason: string }
/** 바뀐 .java → 빌드 결과 .class (IntelliJ 모듈의 Compiler output). */
export type JavaBuild = {
  source: string
  output: string
  /** class 파일 major 버전. Java 8 = 52. */
  major: number
  /** 메인 체크아웃에서 사람이 실행할 빌드 명령(안내용). */
  build?: string
}
export type Connection = {
  protocol: 'ftp'
  host: string
  port?: number
  /** 운영 루트: 압축 푼 WAR 의 맨 위 폴더. */
  root: string
  /** 기본 true. false 면 active 모드. */
  passive?: boolean
}
export type Target = {
  id: string
  label: string
  /** 시험용 대상: 자동 선택하지 않는다. */
  test?: boolean
  /** 메인 체크아웃 (C:/... 형식). */
  repo: string
  mainBranch?: string
  gitRemote?: string
  /** run 기록 폴더. */
  runs: string
  connection: Connection
  /** 옮기는 동안만: 자격 증명 관리자에 없으면 이 netrc 로 접속한다(내용은 읽지 않는다). */
  legacyNetrc?: string
  mappings: Mapping[]
  java?: JavaBuild
  manual: ManualRule[]
  /** 확인용 커밋: 이미 반영된 것이 확실한 커밋. */
  checkCommit?: string
}

export function targetsDir(): string {
  return join(home(), 'targets')
}

const trimSlashes = (s: string) => s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

/** 매핑 경로를 비교하기 좋게: 앞뒤 슬래시 없음, `\` → `/`. */
export function cleanLocal(p: string): string {
  return trimSlashes(p)
}

/** 운영 경로: 늘 `/` 로 시작, 끝 슬래시 없음 (`/` 만은 그대로). */
export function cleanRemote(p: string): string {
  const s = trimSlashes(p)
  return s ? `/${s}` : '/'
}

export function joinRemote(...parts: string[]): string {
  const s = parts.map(trimSlashes).filter((x) => x !== '').join('/')
  return `/${s}`
}

export function mainBranch(t: Target): string {
  return t.mainBranch || 'main'
}

export function gitRemote(t: Target): string {
  return t.gitRemote || 'origin'
}

/**
 * 글롭이 경로 전체와 맞는가. `**` 는 `/` 를 넘고, `*`·`?` 는 넘지 않는다. `**` 뒤에 `/` 가 오면 폴더가 0개여도 맞는다.
 * 정규식으로 바꾸지 않는다: `*a*a*a…` 같은 패턴은 정규식에서 걸리는 시간이 폭증한다. 여기서는 패턴 길이 × 경로 길이만큼만 본다.
 */
export function globMatch(glob: string, path: string): boolean {
  const g = glob.replace(/\\/g, '/')
  const n = path.length
  // ok[j]: 지금까지의 패턴이 경로의 앞 j 글자와 맞는가.
  let ok = new Array<boolean>(n + 1).fill(false)
  ok[0] = true
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    const next = new Array<boolean>(n + 1).fill(false)
    if (c === '*' && g[i + 1] === '*' && g[i + 2] === '/') {
      // `**` + `/`: 아무것도 없거나, `/` 로 끝나는 아무 글자들
      i += 2
      let before = false
      for (let j = 0; j <= n; j++) {
        next[j] = ok[j] || (before && path[j - 1] === '/')
        before = before || ok[j]
      }
    } else if (c === '*' && g[i + 1] === '*') {
      // `**`: 아무 글자들(`/` 포함)
      i++
      let any = false
      for (let j = 0; j <= n; j++) {
        any = any || ok[j]
        next[j] = any
      }
    } else if (c === '*') {
      // `*`: `/` 가 아닌 글자들
      for (let j = 0; j <= n; j++) next[j] = ok[j] || (j > 0 && next[j - 1] && path[j - 1] !== '/')
    } else if (c === '?') {
      for (let j = 0; j < n; j++) next[j + 1] = ok[j] && path[j] !== '/'
    } else {
      for (let j = 0; j < n; j++) next[j + 1] = ok[j] && path[j] === c
    }
    ok = next
  }
  return ok[n]
}

export function manualReason(t: Target, path: string): string | null {
  for (const r of t.manual) if (globMatch(r.pattern, path)) return r.reason
  return null
}

const under = (path: string, dir: string) => dir === '' || path === dir || path.startsWith(dir + '/')

/** 가장 구체적인(로컬 경로가 가장 긴) 매핑. */
export function findMapping(t: Target, path: string): Mapping | null {
  let best: Mapping | null = null
  for (const m of t.mappings) {
    const local = cleanLocal(m.local)
    if (!under(path, local)) continue
    if (!best || local.length > cleanLocal(best.local).length) best = m
  }
  return best
}

/** 저장소 기준 경로 → 운영 경로. 매핑 밖이면 null. */
export function remotePathOf(t: Target, path: string): string | null {
  const m = findMapping(t, path)
  if (!m) return null
  const local = cleanLocal(m.local)
  const rest = local === '' ? path : path.slice(local.length + 1)
  return joinRemote(t.connection.root, m.remote, rest)
}

export function inAnyMapping(t: Target, path: string): boolean {
  return findMapping(t, path) !== null || (!!t.java && under(path, cleanLocal(t.java.source)))
}

const ID = /^[a-z0-9_]+$/

/** 서버 이름·IPv4 주소: 글자·숫자·`.`·`-`·`_` 만, 양 끝은 글자나 숫자. */
const HOST = /^(?=.{1,253}$)[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?$/

const NEED_LABEL = '표시 이름이 필요함'
const NEED_RUNS = 'run 기록 폴더가 필요함'

/**
 * 새 대상의 run 기록 폴더 기본 위치: 플러그인 데이터 폴더 아래(저장소 밖).
 * run 기록에는 운영 파일 백업이 쌓여서, 저장소 안에 두면 실수로 커밋될 수 있다.
 */
export function defaultRuns(id: string): string {
  return join(home(), 'runs', id).replace(/\\/g, '/')
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/**
 * 패널에서 저장할 때: 비워 둔 칸을 기본값으로 채운 설정과 그 설정의 잘못 목록.
 * 표시 이름 → 대상 이름, (새 대상만) run 기록 폴더 → defaultRuns. 이미 있는 대상의 run 기록 폴더는 채우지 않는다 —
 * 이미 쌓인 run 의 위치가 모르는 사이 바뀌면 안 된다.
 * 대상 이름이 틀리면 채울 값이 없다. 그때는 못 채운 칸을 따로 탓하지 않는다(이름을 고치면 채워진다).
 */
export function prepareSave(t: Target, isNew: boolean): { target: Target; errors: string[] } {
  if (!t || typeof t !== 'object') return { target: t, errors: validateTarget(t) }
  const noLabel = blank(t.label)
  const noRuns = isNew && blank(t.runs)
  if (typeof t.id !== 'string' || !ID.test(t.id)) {
    const skip = new Set([...(noLabel ? [NEED_LABEL] : []), ...(noRuns ? [NEED_RUNS] : [])])
    return { target: t, errors: validateTarget(t).filter((x) => !skip.has(x)) }
  }
  const target: Target = { ...t, label: noLabel ? t.id : t.label, runs: noRuns ? defaultRuns(t.id) : t.runs }
  return { target, errors: validateTarget(target) }
}

/** 설정의 잘못을 사람이 읽을 문장으로. 빈 배열이면 쓸 수 있다. */
export function validateTarget(t: Target): string[] {
  const e: string[] = []
  if (!t || typeof t !== 'object') return ['설정이 비었음']
  // 파일을 손으로 고치거나 밖에서 받은 설정도 여기를 지난다: 칸의 형식부터 확인한다(글자가 아닌 값에 걸려 넘어지지 않게).
  const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
  const dotDot = (p: string) => /(^|[\\/])\.\.([\\/]|$)/.test(p)
  const absolute = (p: string) => /^[a-zA-Z]:|^[\\/]/.test(p)
  if (typeof t.id !== 'string' || !ID.test(t.id)) e.push('대상 이름은 영문 소문자·숫자·_ 만 (run 이름 앞부분이라 - 는 못 씀)')
  if (!filled(t.label)) e.push(NEED_LABEL)
  if (!filled(t.repo)) e.push('메인 체크아웃 경로가 필요함')
  if (!filled(t.runs)) e.push(NEED_RUNS)
  const c = t.connection
  if (!c || typeof c !== 'object') e.push('연결 설정이 필요함')
  else {
    if (c.protocol !== 'ftp') e.push('연결 종류는 지금 ftp 만 됨')
    // 호스트는 ftp:// 뒤에 그대로 붙는다. 계정(user:pass@)·포트(:21)·경로·?·# 이 섞이면 접속하는 곳이 달라지고,
    // 계정이 설정 파일과 내보낸 글자에 남는다. 이름이나 IPv4 주소만 받는다(IPv6 는 지원하지 않음).
    if (!filled(c.host) || !HOST.test(c.host)) e.push('호스트는 서버 이름이나 IP 주소만 (예: ftp.example.com) — 계정·포트·경로는 넣지 않음')
    if (c.port !== undefined && !(Number.isInteger(c.port) && c.port > 0 && c.port < 65536)) e.push('포트가 잘못됨')
    if (typeof c.root !== 'string' || !c.root.startsWith('/')) e.push('운영 루트는 / 로 시작해야 함')
    else if (dotDot(c.root)) e.push('운영 루트에 .. 은 못 씀')
  }
  if (!Array.isArray(t.mappings) || t.mappings.length === 0) e.push('경로 매핑이 하나 이상 필요함')
  const seen = new Set<string>()
  let mappingsOk = Array.isArray(t.mappings)
  for (const [i, m] of (Array.isArray(t.mappings) ? t.mappings : []).entries()) {
    const n = `매핑 ${i + 1}`
    if (!m || typeof m.local !== 'string' || typeof m.remote !== 'string') {
      e.push(`${n}: 로컬 경로와 운영 경로가 필요함`)
      mappingsOk = false
      continue
    }
    if (/[*?[\]]/.test(m.local + m.remote)) e.push(`${n}: 매핑은 폴더 경로만 (패턴은 손 처리 규칙에)`)
    if (dotDot(m.local) || dotDot(m.remote)) e.push(`${n}: .. 은 못 씀`)
    if (absolute(m.local)) e.push(`${n}: 로컬 경로는 저장소 기준 상대경로`)
    if (!m.remote.startsWith('/')) e.push(`${n}: 운영 경로는 / 로 시작 (운영 루트 기준)`)
    const k = cleanLocal(m.local)
    if (seen.has(k)) e.push(`${n}: 같은 로컬 경로가 두 번 있음`)
    seen.add(k)
  }
  if (t.java) {
    const j = t.java
    if (!filled(j.source) || !filled(j.output)) e.push('Java 빌드 출력: 소스·결과 폴더가 필요함')
    else {
      if (absolute(j.source) || absolute(j.output)) e.push('Java 빌드 출력: 소스·결과 폴더는 저장소 기준 상대경로')
      if (dotDot(j.source) || dotDot(j.output)) e.push('Java 빌드 출력: .. 은 못 씀')
      if (!Number.isInteger(j.major) || j.major < 45) e.push('Java 빌드 출력: class major 버전이 잘못됨 (Java 8 = 52)')
      else if (mappingsOk && !findMapping(t, cleanLocal(j.output) + '/x.class'))
        e.push('Java 빌드 결과 폴더를 운영에 잇는 경로 매핑이 없음')
    }
  }
  if (t.manual !== undefined && !Array.isArray(t.manual)) e.push('손 처리 규칙의 형식이 틀림')
  for (const [i, r] of (Array.isArray(t.manual) ? t.manual : []).entries()) {
    if (!filled(r?.pattern)) e.push(`손 처리 규칙 ${i + 1}: 패턴이 비었음`)
    if (!filled(r?.reason)) e.push(`손 처리 규칙 ${i + 1}: 이유가 비었음`)
  }
  return e
}

export function listTargetIds(): string[] {
  const dir = targetsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort()
}

export function loadTarget(id: string): Target {
  if (!ID.test(id)) throw new Stop(`대상 이름이 잘못됨: ${id}`)
  const file = join(targetsDir(), `${id}.json`)
  if (!existsSync(file)) {
    const ids = listTargetIds()
    throw new Stop(`대상 없음: ${id} (있는 대상: ${ids.join(' ') || '없음'})`)
  }
  const t = JSON.parse(readFileSync(file, 'utf8')) as Target
  if (t.id !== id) throw new Stop(`대상 파일 이름(${id})과 설정의 id(${t.id})가 다름`)
  t.manual ??= []
  t.mappings ??= []
  // `~/` 는 여기서 펼친다(엔진은 저장소 경로를 그대로 git·fs 에 넘긴다).
  t.repo = expandHome(t.repo)
  return t
}

export function listTargets(): Target[] {
  return listTargetIds().map(loadTarget)
}

/** 검사를 통과한 설정만 쓴다. 임시 파일에 쓰고 이름을 바꿔 반쯤 쓴 파일이 남지 않게. */
export function saveTarget(t: Target): void {
  const errors = validateTarget(t)
  if (errors.length) throw new Stop(`대상 설정이 잘못됨:\n- ${errors.join('\n- ')}`)
  const dir = targetsDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${t.id}.json`)
  // 덮어쓰기 전에 이전 설정을 이력(targets/.history)에 남긴다: run 기록 폴더를 바꿔도 예전 run 을 찾을 수 있게.
  if (existsSync(file)) {
    const history = join(dir, '.history')
    mkdirSync(history, { recursive: true })
    writeFileSync(join(history, `${t.id}-${Date.now()}.json`), readFileSync(file, 'utf8'), 'utf8')
  }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(t, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/**
 * 대상 설정을 지운다. 파일은 targets/.deleted/ 로 옮겨 두어, 이미 올린 run 을 나중에도 열고 되돌릴 수 있게 한다.
 */
export function deleteTarget(id: string): void {
  const file = join(targetsDir(), `${id}.json`)
  if (!existsSync(file)) return
  const graveyard = join(targetsDir(), '.deleted')
  mkdirSync(graveyard, { recursive: true })
  renameSync(file, join(graveyard, `${id}-${Date.now()}.json`))
}

/**
 * 이 이름으로 있었던 설정 전부: 지금 설정(있으면), 지운 설정들(.deleted), 저장 때마다 남긴 이전 설정들(.history).
 * 최근 것부터. run 폴더를 찾을 때 쓴다.
 */
export function targetHistory(id: string): Target[] {
  const out: Target[] = []
  if (existsSync(join(targetsDir(), `${id}.json`))) out.push(loadTarget(id))
  const files: { dir: string; f: string; at: number }[] = []
  for (const sub of ['.deleted', '.history']) {
    const dir = join(targetsDir(), sub)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir))
      if (f.startsWith(`${id}-`) && /^\d+\.json$/.test(f.slice(id.length + 1))) files.push({ dir, f, at: Number(f.slice(id.length + 1, -5)) })
  }
  for (const { dir, f } of files.sort((a, b) => b.at - a.at)) {
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Target
      t.repo = expandHome(t.repo)
      t.manual ??= []
      t.mappings ??= []
      out.push(t)
    } catch {
      // 깨진 보관본은 건너뛴다
    }
  }
  return out
}

/** 지금 설정, 없으면 가장 최근에 지운 설정. 둘 다 없으면 멈춘다. */
export function loadTargetOrDeleted(id: string): Target {
  if (existsSync(join(targetsDir(), `${id}.json`))) return loadTarget(id)
  const graveyard = join(targetsDir(), '.deleted')
  const last = existsSync(graveyard)
    ? readdirSync(graveyard)
        .filter((f) => f.startsWith(`${id}-`) && /^\d+\.json$/.test(f.slice(id.length + 1)))
        .sort((a, b) => Number(a.slice(id.length + 1, -5)) - Number(b.slice(id.length + 1, -5)))
        .pop()
    : undefined
  if (!last) return loadTarget(id)
  const t = JSON.parse(readFileSync(join(graveyard, last), 'utf8')) as Target
  t.repo = expandHome(t.repo)
  t.manual ??= []
  t.mappings ??= []
  return t
}

/**
 * plan 결과에 영향을 주는 설정(저장소·연결·매핑·Java·손 처리 규칙)의 지문. run 에 남은 사본과 지금 설정의 지문이
 * 다르면, 그 run 은 지금 설정으로 만든 plan 이 아니다.
 */
export function configKey(t: Target): string {
  const c = t.connection
  return JSON.stringify({
    repo: expandHome(t.repo).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
    mainBranch: mainBranch(t),
    host: c.host,
    port: c.port ?? 21,
    root: cleanRemote(c.root),
    passive: c.passive !== false,
    mappings: t.mappings.map((m) => [cleanLocal(m.local), cleanRemote(m.remote)]),
    java: t.java ? [cleanLocal(t.java.source), cleanLocal(t.java.output), t.java.major] : null,
    manual: (t.manual ?? []).map((r) => [r.pattern, r.reason])
  })
}

export function netrcPath(t: Target): string | null {
  return t.legacyNetrc ? expandHome(t.legacyNetrc) : null
}

export type Detection = { target: string | null; candidates: string[]; repoKnown: boolean }

/** 폴더(작업공간·현재 폴더)의 저장소로 대상을 찾는다. 시험용 대상은 빼고, 둘 이상이면 고르지 않는다. */
export async function detectTarget(dir: string): Promise<Detection> {
  const common = await commonDir(dir)
  if (!common) return { target: null, candidates: [], repoKnown: false }
  const candidates: string[] = []
  for (const t of listTargets()) {
    if (t.test) continue
    if ((await commonDir(t.repo)) === common) candidates.push(t.id)
  }
  return { target: candidates.length === 1 ? candidates[0] : null, candidates, repoKnown: true }
}

/** 이 폴더의 저장소가 대상의 저장소와 같은가. 모르면 null. */
export async function sameRepo(dir: string, t: Target): Promise<boolean | null> {
  const a = await commonDir(dir)
  if (!a) return null
  return a === (await commonDir(t.repo))
}

/** 메인 체크아웃을 쓸 수 없으면(없음·폴더가 아님·열 수 없음) 사람에게 보여 줄 말, 쓸 수 있으면 null. */
export function repoProblem(repo: string): string | null {
  let ok = false
  try {
    ok = statSync(toNative(repo)).isDirectory()
  } catch {
    // 없거나 열 수 없음
  }
  return ok ? null : `메인 체크아웃이 없음: ${repo} — 대상 설정의 메인 체크아웃을 이 PC 에 있는 폴더 경로로 고치세요`
}
