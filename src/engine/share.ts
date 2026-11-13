// 대상 설정 공유. 팀이 같이 쓰는 설정(FTP 주소·운영 루트·경로 매핑·Java·손 처리 규칙·확인용 커밋)만 글자로 내보내고,
// 받은 글자는 엄격히 검사해 새 대상의 초안으로 만든다. PC 마다 다른 것(메인 체크아웃·run 기록 폴더·접속 정보)은
// 내보내지 않는다: 받은 사람이 자기 PC 에 맞게 넣는다.
import { validateTarget, type Target } from './target.ts'

export const SHARE_FORMAT = 'orca-prod-deploy-target'
export const SHARE_VERSION = 1

export type SharedTarget = {
  format: typeof SHARE_FORMAT
  version: typeof SHARE_VERSION
  id: string
  label: string
  test?: boolean
  mainBranch?: string
  connection: { protocol: 'ftp'; host: string; port?: number; root: string; passive?: boolean }
  mappings: { local: string; remote: string }[]
  java?: { source: string; output: string; major: number }
  manual: { pattern: string; reason: string }[]
  checkCommit?: string
  /** 이 대상의 저장소 이름표(`github.com/owner/name`). 받는 쪽이 자기 PC 에서 그 저장소를 받아 둔 폴더를 찾는 데 쓴다. */
  remote?: string
}

/** 저장소 이름표의 모양: `호스트[:포트]/경로…`. 호스트는 소문자, 경로는 적힌 그대로. 계정·프로토콜·`.git` 없음. */
const IDENTITY = /^(?=.{3,200}$)[a-z0-9_][a-z0-9._-]*(:\d{1,5})?(\/[A-Za-z0-9._~-]+)+$/

/** 원격 저장소에 닿는 프로토콜과 기본 포트. 그 밖(file 등)은 이 PC 나 내부 공유 폴더의 경로라 내보내지 않는다. */
const DEFAULT_PORT: Record<string, string> = { https: '443', http: '80', ssh: '22', git: '9418' }

/**
 * git 원격 주소 → 저장소 이름표. 주소 앞의 계정·토큰(`https://user:token@…`)과 프로토콜·`.git` 을 뗀다.
 * - 경로는 그대로 둔다(대소문자 포함): 다른 저장소가 같은 이름표가 되지 않게. 경로 안에 든 값까지 비밀인지는
 *   알 수 없으므로, 내보낸 글자의 저장소 주소는 보내는 사람이 읽어 봐야 한다.
 * - 기본 포트가 아니면 포트를 남긴다: 같은 서버의 다른 포트는 다른 서비스다.
 * - file 주소·로컬 경로처럼 원격 저장소가 아닌 주소는 null.
 */
export function repoIdentity(url: string): string | null {
  const s = url.trim()
  let host: string
  let port = ''
  let path: string
  // scheme://[계정@]호스트[:포트]/경로
  const full = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:@]+)(?::(\d+))?\/(.+)$/i.exec(s)
  if (full) {
    const scheme = full[1].toLowerCase()
    if (!(scheme in DEFAULT_PORT)) return null
    host = full[2]
    if (full[3] && full[3] !== DEFAULT_PORT[scheme]) port = `:${full[3]}`
    path = full[4]
  } else {
    // [계정@]호스트:경로 (git@github.com:owner/name.git). 드라이브 경로(C:/…, C:\…)는 걸리지 않게 호스트는 두 글자 이상.
    const scp = /^(?:[^@/]+@)?([^/:@]{2,}):(?![/\\])(.+)$/.exec(s)
    if (!scp) return null
    host = scp[1]
    path = scp[2]
  }
  const id = `${host.toLowerCase()}${port}/${path.replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '')}`
  return IDENTITY.test(id) ? id : null
}

/** 경로의 대소문자를 가리지 않는 것으로 알려진 호스트. 그 밖의 서버는 대소문자가 다르면 다른 저장소로 본다. */
const CASE_INSENSITIVE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])

/** 두 이름표가 같은 저장소인가. 모호하면 같다고 하지 않는다(다른 저장소를 메인 체크아웃으로 제안하지 않게). */
export function sameRepoIdentity(a: string, b: string): boolean {
  if (a === b) return true
  const host = a.slice(0, a.indexOf('/'))
  return CASE_INSENSITIVE_HOSTS.has(host) && a.toLowerCase() === b.toLowerCase()
}

/**
 * 내보낼 항목만 하나씩 옮긴다(전체를 복사한 뒤 빼는 방식이 아니다: 나중에 생긴 칸이 저절로 새어 나가지 않게).
 * 뺀 것: repo, runs, legacyNetrc, gitRemote(PC 마다 다름), java.build(개인 경로·명령이 들어갈 수 있음).
 * remote 는 저장소 이름표(계정을 뗀 것)이고, 이름표 모양이 아니면 넣지 않는다.
 */
export function exportTarget(t: Target, remote?: string | null): SharedTarget {
  const c = t.connection
  const out: SharedTarget = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    id: t.id,
    label: t.label,
    connection: { protocol: 'ftp', host: c.host, root: c.root },
    mappings: t.mappings.map((m) => ({ local: m.local, remote: m.remote })),
    manual: (t.manual ?? []).map((r) => ({ pattern: r.pattern, reason: r.reason }))
  }
  if (t.test) out.test = true
  if (t.mainBranch) out.mainBranch = t.mainBranch
  if (c.port !== undefined) out.connection.port = c.port
  if (c.passive !== undefined) out.connection.passive = c.passive
  if (t.java) out.java = { source: t.java.source, output: t.java.output, major: t.java.major }
  if (t.checkCommit) out.checkCommit = t.checkCommit
  if (remote && IDENTITY.test(remote)) out.remote = remote
  return out
}

export function exportText(t: Target, remote?: string | null): string {
  return JSON.stringify(exportTarget(t, remote), null, 2)
}

/**
 * 내보낼 글자를 만들고, 받는 쪽 검사를 그대로 돌려 본다. 받는 쪽에서 거절될 글자(너무 긴 값, 계정이 섞인 호스트 등)는
 * 내보내지 않고 이유를 알려 준다: 보낸 뒤에야 못 쓰는 것을 알게 되지 않게.
 */
export function exportChecked(t: Target, remote?: string | null): { text: string | null; errors: string[] } {
  const text = exportText(t, remote)
  const { errors } = parseShared(text)
  return errors.length ? { text: null, errors } : { text, errors: [] }
}

const MAX_TEXT = 200_000
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// 제어 문자(탭·개행 포함): run 기록이 탭으로 나눈 줄이라 값에 들어가면 줄이 깨진다.
// 보이지 않는 글자·글 방향을 바꾸는 글자도 막는다: 화면에 보이는 경로와 실제 경로가 달라 보이게 할 수 있다.
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/
const dotDot = (p: string) => /(^|[\\/])\.\.([\\/]|$)/.test(p)

/** 받은 글자를 읽는다. 하나라도 틀리면 shared 는 null 이고, 무엇이 틀렸는지 errors 에 담는다. */
export function parseShared(text: string): { shared: SharedTarget | null; errors: string[] } {
  const errors: string[] = []
  const fail = (...e: string[]) => ({ shared: null, errors: e })
  if (typeof text !== 'string' || !text.trim()) return fail('붙여 넣은 글자가 없음')
  if (text.length > MAX_TEXT) return fail('글자가 너무 김 — 내보낸 글자만 붙여 넣으세요')
  // 메신저에서 코드 블록으로 받은 경우의 ``` 줄과 BOM 은 떼고 읽는다.
  const body = text
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^```[a-zA-Z]*\s*\n/, '')
    .replace(/\n```\s*$/, '')
  // 같은 항목이 두 번 적혀 있으면 뒤의 값을 쓴다(JSON.parse 의 동작). 검사하는 값과 편집기에 보여 주고 저장하는 값이
  // 같은 하나라서, 앞의 값으로 검사를 속이고 뒤의 값을 쓰게 할 수는 없다.
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return fail('글자를 읽을 수 없음(JSON 아님) — 내보낸 글자를 처음부터 끝까지 붙여 넣었는지 확인하세요')
  }
  if (!isObject(raw)) return fail('대상 설정을 내보낸 글자가 아님')
  if (raw.format !== SHARE_FORMAT) {
    if ('repo' in raw || 'runs' in raw)
      return fail('대상 설정 파일을 그대로 붙여 넣은 것 같습니다 — 보내는 사람이 대상 설정 탭의 "내보내기"로 만든 글자를 쓰세요(개인 경로가 빠진 글자)')
    return fail('대상 설정을 내보낸 글자가 아님 — 대상 설정 탭의 "내보내기"로 만든 글자를 붙여 넣으세요')
  }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) return fail('형식 버전이 없음')
  if (raw.version > SHARE_VERSION) return fail(`이 플러그인보다 새 형식(v${raw.version}) — 플러그인을 최신으로 받으세요(git pull)`)
  if (raw.version !== SHARE_VERSION) return fail(`지원하지 않는 형식 버전: v${raw.version}`)

  // 모르는 항목은 조용히 버리지 않는다: 빠지면 안 되는 규칙이 버려질 수 있다.
  const known = (obj: Record<string, unknown>, keys: string[], where: string) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${where}알 수 없는 항목: ${k}`)
  }
  const text1 = (v: unknown, name: string, max: number, required = true): string | undefined => {
    if (v === undefined && !required) return undefined
    if (typeof v !== 'string') return void errors.push(`${name}: 글자가 아님`)
    if (v.length > max) return void errors.push(`${name}: 너무 김(${max}자까지)`)
    if (CONTROL.test(v)) return void errors.push(`${name}: 줄바꿈·탭 같은 제어 문자나 보이지 않는 글자는 못 씀`)
    if (required && !v.trim()) return void errors.push(`${name}: 비었음`)
    return v
  }
  const flag = (v: unknown, name: string): boolean | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'boolean') return void errors.push(`${name}: true/false 가 아님`)
    return v
  }
  /** 저장소 기준 상대 경로: 드라이브·맨 앞 슬래시·`..` 가 없어야 한다. 빈 글자(저장소 맨 위)는 allowEmpty 일 때만. */
  const local = (v: unknown, name: string, allowEmpty = false): string | undefined => {
    if (allowEmpty && v === '') return ''
    const s = text1(v, name, 300)
    if (s === undefined) return undefined
    if (/^[a-zA-Z]:|^[\\/]/.test(s)) return void errors.push(`${name}: 저장소 기준 상대 경로여야 함`)
    if (dotDot(s)) return void errors.push(`${name}: .. 은 못 씀`)
    return s
  }
  const remote = (v: unknown, name: string): string | undefined => {
    const s = text1(v, name, 300)
    if (s === undefined) return undefined
    if (!s.startsWith('/')) return void errors.push(`${name}: / 로 시작해야 함`)
    if (dotDot(s)) return void errors.push(`${name}: .. 은 못 씀`)
    return s
  }

  known(raw, ['format', 'version', 'id', 'label', 'test', 'mainBranch', 'connection', 'mappings', 'java', 'manual', 'checkCommit', 'remote'], '')
  const remoteId = text1(raw.remote, '저장소 주소', 200, false)
  if (remoteId !== undefined && !IDENTITY.test(remoteId)) errors.push('저장소 주소: 형식이 틀림(예: github.com/owner/name — 계정·프로토콜 없이)')
  const id = text1(raw.id, '이름', 40)
  if (id !== undefined && !/^[a-z0-9_]+$/.test(id)) errors.push('이름: 영문 소문자·숫자·_ 만')
  const label = text1(raw.label, '표시 이름', 100)
  const test = flag(raw.test, '시험용 대상')
  const mainBranch = text1(raw.mainBranch, 'main 브랜치', 100, false)
  if (mainBranch !== undefined && /\s/.test(mainBranch)) errors.push('main 브랜치: 빈칸은 못 씀')
  const checkCommit = text1(raw.checkCommit, '확인용 커밋', 80, false)
  if (checkCommit !== undefined && /\s/.test(checkCommit)) errors.push('확인용 커밋: 빈칸은 못 씀')

  let connection: SharedTarget['connection'] | undefined
  if (!isObject(raw.connection)) errors.push('연결: 없음')
  else {
    const c = raw.connection
    known(c, ['protocol', 'host', 'port', 'root', 'passive'], '연결의 ')
    if (c.protocol !== 'ftp') errors.push('연결: 종류는 ftp 만 됨')
    const host = text1(c.host, '호스트', 255)
    const root = remote(c.root, '운영 루트')
    const passive = flag(c.passive, '패시브 모드')
    let port: number | undefined
    if (c.port !== undefined) {
      if (typeof c.port !== 'number' || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) errors.push('포트: 1~65535 의 수가 아님')
      else port = c.port
    }
    if (host !== undefined && root !== undefined) {
      connection = { protocol: 'ftp', host, root }
      if (port !== undefined) connection.port = port
      if (passive !== undefined) connection.passive = passive
    }
  }

  const mappings: SharedTarget['mappings'] = []
  if (!Array.isArray(raw.mappings) || raw.mappings.length === 0) errors.push('경로 매핑: 하나 이상 있어야 함')
  else if (raw.mappings.length > 100) errors.push('경로 매핑: 너무 많음(100개까지)')
  else
    for (const [i, m] of raw.mappings.entries()) {
      const n = `경로 매핑 ${i + 1}`
      if (!isObject(m)) {
        errors.push(`${n}: 형식이 틀림`)
        continue
      }
      known(m, ['local', 'remote'], `${n}의 `)
      // 로컬 경로가 빈 글자면 저장소 맨 위 폴더 전체를 잇는 매핑이다(대상 설정에서 되는 것은 여기서도 된다).
      const l = local(m.local, `${n} 로컬 경로`, true)
      const r = remote(m.remote, `${n} 운영 경로`)
      if (l !== undefined && r !== undefined) mappings.push({ local: l, remote: r })
    }

  let java: SharedTarget['java']
  if (raw.java !== undefined) {
    if (!isObject(raw.java)) errors.push('Java 빌드 출력: 형식이 틀림')
    else {
      known(raw.java, ['source', 'output', 'major'], 'Java 빌드 출력의 ')
      const source = local(raw.java.source, 'Java 소스 폴더')
      const output = local(raw.java.output, 'Java 빌드 결과 폴더')
      const major = raw.java.major
      if (typeof major !== 'number' || !Number.isInteger(major) || major < 45 || major > 200) errors.push('class major 버전: 수가 아님(Java 8 = 52)')
      else if (source !== undefined && output !== undefined) java = { source, output, major }
    }
  }

  // 손 처리 규칙은 위에서부터 처음 맞는 것을 쓰므로 순서를 그대로 둔다.
  const manual: SharedTarget['manual'] = []
  if (raw.manual !== undefined && !Array.isArray(raw.manual)) errors.push('손 처리 규칙: 형식이 틀림')
  else if (Array.isArray(raw.manual)) {
    if (raw.manual.length > 300) errors.push('손 처리 규칙: 너무 많음(300개까지)')
    else
      for (const [i, r] of raw.manual.entries()) {
        const n = `손 처리 규칙 ${i + 1}`
        if (!isObject(r)) {
          errors.push(`${n}: 형식이 틀림`)
          continue
        }
        known(r, ['pattern', 'reason'], `${n}의 `)
        const pattern = text1(r.pattern, `${n} 패턴`, 300)
        const reason = text1(r.reason, `${n} 이유`, 300)
        if (pattern !== undefined && reason !== undefined) manual.push({ pattern, reason })
      }
  }

  if (errors.length || id === undefined || label === undefined || !connection) return { shared: null, errors }
  const shared: SharedTarget = { format: SHARE_FORMAT, version: SHARE_VERSION, id, label, connection, mappings, manual }
  if (test) shared.test = true
  if (mainBranch) shared.mainBranch = mainBranch
  if (java) shared.java = java
  if (checkCommit) shared.checkCommit = checkCommit
  if (remoteId) shared.remote = remoteId
  // 뜻이 맞는지(예: class 를 운영에 잇는 매핑이 있는지)는 대상 설정 검사로 본다. 경로 두 개는 받는 사람이 넣는다.
  const semantic = validateTarget(sharedToTarget(shared, 'C:/placeholder', 'C:/placeholder'))
  if (semantic.length) return { shared: null, errors: semantic }
  return { shared, errors: [] }
}

/** 받은 설정에 이 PC 의 경로 두 개를 더해 대상 설정으로 만든다. */
export function sharedToTarget(s: SharedTarget, repo: string, runs: string): Target {
  const t: Target = {
    id: s.id,
    label: s.label,
    repo,
    mainBranch: s.mainBranch ?? 'main',
    runs,
    connection: { ...s.connection },
    mappings: s.mappings.map((m) => ({ ...m })),
    manual: s.manual.map((r) => ({ ...r }))
  }
  if (s.test) t.test = true
  if (s.java) t.java = { ...s.java }
  if (s.checkCommit) t.checkCommit = s.checkCommit
  return t
}
