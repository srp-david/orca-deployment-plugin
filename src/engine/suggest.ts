// "저장소에서 채우기": 메인 체크아웃의 폴더 구조를 보고 경로 매핑·Java 빌드 출력·손 처리 규칙을 제안한다.
// 이 PC 의 폴더만 읽는다(운영에 접속하지 않음). 제안은 대상 설정의 초안에 넣을 뿐이고, 저장은 사람이 보고 누른다.
import { closeSync, opendirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { cleanLocal, cleanRemote, findMapping, joinRemote, type JavaBuild, type ManualRule, type Mapping, type Target } from './target.ts'
import { exec, toNative } from './util.ts'

export type Suggestion = {
  /** 저장소의 기본 브랜치(이 PC 에 받아 둔 origin/HEAD). 모르면 null. */
  mainBranch: string | null
  mappings: Mapping[]
  java: JavaBuild | null
  /** class major 버전을 어디서 알았는가. */
  majorFrom: 'class' | 'build-file' | 'default' | null
  manual: ManualRule[]
  /** 소스 폴더에 있는 .java 가 아닌 추적 파일: 개수와 몇 개의 예. 있으면 소스 폴더를 classes 로 잇는 매핑을 제안한다. */
  sourceExtras: { count: number; samples: string[] }
}

const SEPARATE = '운영 서버가 별도 파일을 씀 — 필요한 변경만 손으로'

/** "새 대상"의 빈 초안에 기본으로 들어 있는 값(패널의 blankTarget 과 같다). 이 값 그대로일 때만 저장소에 맞춰 고친다. */
const BLANK_MAPPING: Mapping = { local: 'src/main/webapp', remote: '/' }
const BLANK_BRANCH = 'main'

/** 그 경로가 폴더인가. */
export const isDir = (p: string): boolean => {
  try {
    return statSync(toNative(p)).isDirectory()
  } catch {
    return false
  }
}
const isFile = (p: string): boolean => {
  try {
    return statSync(toNative(p)).isFile()
  } catch {
    return false
  }
}
/** 빌드 파일을 글자로. 없거나 너무 크면 빈 글자. */
const text = (p: string): string => {
  try {
    const st = statSync(toNative(p))
    return st.isFile() && st.size <= 1_000_000 ? readFileSync(toNative(p), 'utf8') : ''
  } catch {
    return ''
  }
}

/** Java 버전 표기(`1.8`, `VERSION_1_8`, `17`) → class major. 모르면 null. */
export function majorOfJava(v: string): number | null {
  const m = /^(?:1[._])?(\d{1,2})$/.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  return n >= 5 && n <= 40 ? 44 + n : null
}

/** 빌드 파일에 적힌 Java 버전에서 class major 를 어림한다(target 이 source 보다 먼저). 주석은 빼고 본다. 못 찾으면 null. */
export function majorFromBuildFile(gradle: string, pom: string): number | null {
  const first = (s: string, res: RegExp[]): number | null => {
    for (const re of res) {
      const m = re.exec(s)
      const major = m ? majorOfJava(m[1]) : null
      if (major) return major
    }
    return null
  }
  const code = gradle.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const xml = pom.replace(/<!--[\s\S]*?-->/g, ' ')
  const ver = String.raw`['"]?(?:JavaVersion\.VERSION_)?(1[._]\d|\d{1,2})\b`
  return (
    first(code, [
      new RegExp(String.raw`\boptions\.release\s*(?:=|\.set\()\s*(\d{1,2})\b`),
      new RegExp(String.raw`\btargetCompatibility\s*=?\s*` + ver),
      new RegExp(String.raw`\bsourceCompatibility\s*=?\s*` + ver),
      /JavaLanguageVersion\.of\(\s*(\d{1,2})\s*\)/
    ]) ??
    first(xml, [
      /<maven\.compiler\.release>\s*(\d{1,2})\s*</,
      /<maven\.compiler\.target>\s*(1\.\d|\d{1,2})\s*</,
      /<release>\s*(\d{1,2})\s*</,
      /<target>\s*(1\.\d|\d{1,2})\s*</,
      /<java\.version>\s*(1\.\d|\d{1,2})\s*</,
      /<maven\.compiler\.source>\s*(1\.\d|\d{1,2})\s*</
    ])
  )
}

/** class 파일의 머리 8바이트(CAFEBABE, minor, major)만 읽어 major 를 준다. class 가 아니면 null. */
function majorOfClassFile(p: string): number | null {
  let fd: number | null = null
  try {
    fd = openSync(toNative(p), 'r')
    const head = Buffer.alloc(8)
    if (readSync(fd, head, 0, 8, 0) !== 8 || head.readUInt32BE(0) !== 0xcafebabe) return null
    const major = head.readUInt16BE(6)
    return major >= 45 && major <= 100 ? major : null
  } catch {
    return null
  } finally {
    if (fd !== null)
      try {
        closeSync(fd)
      } catch {
        // 무시
      }
  }
}

/**
 * 빌드 결과 폴더에서 class 하나를 찾아 major 를 읽는다. 오래 걸리거나 저장소 밖으로 나가지 않게:
 * 폴더는 한 항목씩 읽고(전체를 한꺼번에 읽지 않음), 본 항목 수와 깊이를 제한하고, 링크(심볼릭 링크·junction)는 따라가지 않는다.
 */
function majorFromClasses(dir: string): number | null {
  let seen = 0
  const walk = (d: string, depth: number): number | null => {
    if (depth > 12) return null
    const subs: string[] = []
    let handle
    try {
      handle = opendirSync(toNative(d))
    } catch {
      return null
    }
    try {
      for (;;) {
        const ent = handle.readSync()
        if (!ent) break
        if (++seen > 3000) return null
        if (ent.isSymbolicLink()) continue
        if (ent.isFile() && ent.name.endsWith('.class')) {
          const major = majorOfClassFile(`${d}/${ent.name}`)
          if (major !== null) return major
        } else if (ent.isDirectory() && subs.length < 200) subs.push(ent.name)
      }
    } catch {
      return null
    } finally {
      try {
        handle.closeSync()
      } catch {
        // 무시
      }
    }
    for (const name of subs) {
      const got = walk(`${d}/${name}`, depth + 1)
      if (got !== null || seen > 3000) return got
    }
    return null
  }
  return walk(dir, 0)
}

async function gitOut(repo: string, args: string[]): Promise<string | null> {
  const r = await exec('git', ['-C', toNative(repo), '-c', 'core.quotePath=false', ...args], { timeoutMs: 10000 })
  return r.code === 0 ? r.out.toString('utf8') : null
}

/** 저장소(맨 위 폴더)의 구조를 보고 만든 제안. 있는 폴더·파일만 근거로 삼는다. */
export async function suggestFromRepo(repo: string): Promise<Suggestion> {
  const root = repo.replace(/\\/g, '/').replace(/\/+$/, '')
  const at = (rel: string) => `${root}/${rel}`
  const mappings: Mapping[] = []
  const manual: ManualRule[] = []
  let sourceExtras = { count: 0, samples: [] as string[] }

  // 화면·정적 파일: WAR 의 맨 위로 들어가는 폴더
  const webapp = ['src/main/webapp', 'WebContent'].find((d) => isDir(at(d))) ?? null
  if (webapp) mappings.push({ local: webapp, remote: '/' })

  // Java: 소스 폴더와, 빌드 도구가 class 를 내놓는 폴더
  const gradle = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) => isFile(at(f)))
  const maven = isFile(at('pom.xml'))
  const source = isDir(at('src/main/java')) ? 'src/main/java' : null
  const output = gradle
    ? 'build/classes/java/main'
    : maven
      ? 'target/classes'
      : (['build/classes/java/main', 'target/classes', 'out/production/classes', 'build/classes'].find((d) => isDir(at(d))) ?? null)
  let java: JavaBuild | null = null
  let majorFrom: Suggestion['majorFrom'] = null
  if (source && output) {
    let major = majorFromClasses(at(output))
    majorFrom = major ? 'class' : null
    if (!major) {
      major = majorFromBuildFile(text(at('build.gradle')) + '\n' + text(at('build.gradle.kts')), text(at('pom.xml')))
      majorFrom = major ? 'build-file' : 'default'
    }
    const build = gradle
      ? isFile(at('gradlew.bat'))
        ? '.\\gradlew.bat classes'
        : 'gradle classes'
      : maven
        ? isFile(at('mvnw.cmd'))
          ? '.\\mvnw.cmd compile'
          : 'mvn compile'
        : undefined
    java = { source, output, major: major ?? 52, ...(build ? { build } : {}) }
    mappings.push({ local: output, remote: '/WEB-INF/classes' })
    // 소스 폴더에 .java 가 아닌 파일(쿼리 XML 등)이 있으면 보통 빌드가 그 파일도 classes 로 옮긴다.
    // git 이 추적하는 파일만 본다(서브모듈 자리는 뺀다: -s 의 mode 160000).
    const listed = await gitOut(root, ['ls-files', '-s', '-z', '--', source, `:(exclude)${source}/**/*.java`, `:(exclude)${source}/*.java`])
    const extras = (listed ?? '')
      .split('\0')
      .filter((x) => x !== '' && !x.startsWith('160000 '))
      .map((x) => x.slice(x.indexOf('\t') + 1))
    if (extras.length) {
      sourceExtras = { count: extras.length, samples: extras.slice(0, 3) }
      mappings.push({ local: source, remote: '/WEB-INF/classes' })
    }
  }

  // 서버마다 따로 두는 파일: 올리지 않고 손으로 처리하게 한다(있는 것만).
  if (webapp && isFile(at(`${webapp}/WEB-INF/web.xml`))) manual.push({ pattern: `${webapp}/WEB-INF/web.xml`, reason: SEPARATE })
  if (webapp && isDir(at(`${webapp}/META-INF`))) manual.push({ pattern: `${webapp}/META-INF/**`, reason: SEPARATE })
  if (webapp && isDir(at(`${webapp}/WEB-INF/lib`)))
    manual.push({ pattern: `${webapp}/WEB-INF/lib/**`, reason: 'jar 교체 — 백업·재기동과 함께 손으로' })
  if (isDir(at('src/main/resources'))) manual.push({ pattern: 'src/main/resources/**', reason: '환경별 설정(logback 등) — 손으로' })
  for (const d of ['libs', 'lib']) if (isDir(at(d))) manual.push({ pattern: `${d}/**`, reason: 'jar 교체 — 백업·재기동과 함께 손으로' })

  const head = await gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const mainBranch = head?.trim().replace(/^origin\//, '') || null
  return { mainBranch, mappings, java, majorFrom, manual, sourceExtras }
}

const javaName = (major: number) => (major >= 49 ? `Java ${major - 44}` : `major ${major}`)

/**
 * 제안을 설정 초안에 넣는다. 있는 값은 바꾸지 않고 빠진 것만 넣으며, 다른 점은 알려 주기만 한다.
 * 이미 있는 매핑이 그 폴더를 다른 곳으로 잇고 있으면(위 폴더의 매핑 포함) 새 매핑을 넣지 않는다 — 넣으면 반영 위치가 바뀐다.
 * tidy(저장한 적 없는 "새 대상" 초안): 처음 들어 있던 기본값 그대로인 것만 저장소에 맞춘다 —
 * 기본 매핑(src/main/webapp → /)의 폴더가 없으면 빼고, main 브랜치가 기본값(main)이면 저장소의 기본 브랜치로 바꾼다.
 * 사람이 고친 값은 건드리지 않는다.
 * exists: 저장소 기준 경로의 폴더가 있는가.
 */
export function mergeSuggestion(
  t: Target,
  s: Suggestion,
  o: { tidy: boolean; exists: (rel: string) => boolean }
): { target: Target; notes: string[] } {
  const notes: string[] = []
  const out: Target = { ...t, mappings: [...(t.mappings ?? [])], manual: [...(t.manual ?? [])] }

  // 경로 매핑. 빌드 결과 폴더는 빌드 전이면 없는 것이 정상이라 "없는 폴더"로 치지 않는다.
  const outputs = new Set([t.java?.output, s.java?.output].filter((x): x is string => !!x).map(cleanLocal))
  const gone = out.mappings.filter((m) => {
    const local = cleanLocal(m.local)
    return local !== '' && !outputs.has(local) && !o.exists(local)
  })
  const isBlank = (m: Mapping) => cleanLocal(m.local) === BLANK_MAPPING.local && cleanRemote(m.remote) === BLANK_MAPPING.remote
  const dropped = o.tidy ? gone.filter(isBlank) : []
  if (dropped.length) {
    out.mappings = out.mappings.filter((m) => !dropped.includes(m))
    notes.push(`저장소에 없는 폴더의 기본 경로 매핑을 뺐습니다: ${dropped.map((m) => m.local).join(', ')}`)
  }
  const kept = gone.filter((m) => !dropped.includes(m))
  if (kept.length) notes.push(`저장소에 없는 폴더를 가리키는 경로 매핑이 있습니다(그대로 둠): ${kept.map((m) => m.local).join(', ')}`)

  // 있던 매핑(뺀 것 제외)이 그 폴더를 이미 어디론가 잇고 있는지 보고 넣는다.
  const before = { ...out, mappings: [...out.mappings] }
  const added: Mapping[] = []
  for (const m of s.mappings) {
    const local = cleanLocal(m.local)
    const via = findMapping(before, local)
    if (!via) {
      out.mappings.push(m)
      added.push(m)
      continue
    }
    const viaLocal = cleanLocal(via.local)
    const now = joinRemote(via.remote, viaLocal === '' ? local : local.slice(viaLocal.length))
    if (now === cleanRemote(m.remote)) continue
    notes.push(
      viaLocal === local
        ? `경로 매핑 ${via.local} → ${via.remote} 은 그대로 뒀습니다(보통은 → ${m.remote}).`
        : `${m.local} 은 이미 경로 매핑 ${via.local || '(저장소 맨 위)'} → ${via.remote} 로 운영의 ${now} 에 이어져 있어, 새 매핑을 넣지 않았습니다(보통은 → ${m.remote}).`
    )
  }
  if (added.length) notes.push(`경로 매핑 ${added.length}개를 넣었습니다: ${added.map((m) => `${m.local} → ${m.remote}`).join(', ')}`)
  if (s.java && s.sourceExtras.count && added.some((m) => cleanLocal(m.local) === cleanLocal(s.java!.source)))
    notes.push(
      `${s.java.source} → /WEB-INF/classes 는 소스 폴더에 .java 가 아닌 파일이 ${s.sourceExtras.count}개 있어서 넣었습니다(예: ${s.sourceExtras.samples.join(', ')}). ` +
        '이 매핑이 있으면 그 폴더의 .java 아닌 파일이 바뀔 때 운영에 올라갑니다. 빌드가 classes 로 옮기지 않는 파일뿐이면 이 매핑을 지우세요.'
    )

  // Java 빌드 출력
  if (s.java) {
    const from =
      s.majorFrom === 'class'
        ? '빌드된 class 에서 읽음'
        : s.majorFrom === 'build-file'
          ? '빌드 파일에서 읽음 — 빌드한 뒤 다시 누르면 class 에서 확인합니다'
          : '알 수 없어 Java 8 로 둠 — 빌드한 뒤 다시 누르면 class 에서 읽습니다'
    if (!out.java) {
      out.java = s.java
      notes.push(`Java 빌드 출력을 넣었습니다: 소스 ${s.java.source}, 결과 ${s.java.output}, ${javaName(s.java.major)}(${from}).`)
      if (s.java.build) notes.push(`빌드 명령은 ${s.java.build} 로 넣었습니다(안내용). 이 PC 의 JDK 설정에 맞게 고치세요.`)
    } else {
      if (!out.java.build?.trim() && s.java.build) {
        out.java = { ...out.java, build: s.java.build }
        notes.push(`비어 있던 빌드 명령에 ${s.java.build} 를 넣었습니다(안내용). 이 PC 의 JDK 설정에 맞게 고치세요.`)
      }
      if (cleanLocal(out.java.source) !== s.java.source || cleanLocal(out.java.output) !== s.java.output)
        notes.push(`Java 소스·결과 폴더는 그대로 뒀습니다(저장소 구조로는 소스 ${s.java.source}, 결과 ${s.java.output}).`)
      if (out.java.major !== s.java.major) {
        if (s.majorFrom === 'class')
          notes.push(`빌드된 class 는 ${javaName(s.java.major)}(major ${s.java.major})인데 설정은 major ${out.java.major} 입니다. 그대로 뒀으니 확인하세요.`)
        else if (s.majorFrom === 'build-file')
          notes.push(`빌드 파일에는 ${javaName(s.java.major)}(major ${s.java.major})로 적혀 있는데 설정은 major ${out.java.major} 입니다. 그대로 뒀습니다(빌드 파일은 어림이라 틀릴 수 있음).`)
      }
    }
  } else if (!out.java) notes.push('Java 소스 폴더(src/main/java)나 빌드 결과 폴더를 찾지 못해 Java 빌드 출력은 넣지 않았습니다.')

  // 손 처리 규칙: 뒤에 붙인다(위에서부터 처음 맞는 규칙을 쓰므로 있던 규칙이 먼저다).
  const rules = s.manual.filter((r) => !out.manual.some((x) => x.pattern === r.pattern))
  if (rules.length) {
    out.manual.push(...rules)
    notes.push(`손 처리 규칙 ${rules.length}개를 넣었습니다(올리지 않고 이유를 보여 줌): ${rules.map((r) => r.pattern).join(', ')}`)
  }

  // main 브랜치: 기본값 그대로일 때만 맞추고, 사람이 정한 값이면 알려 주기만 한다.
  const now = out.mainBranch || BLANK_BRANCH
  if (s.mainBranch && s.mainBranch !== now) {
    if (o.tidy && now === BLANK_BRANCH) {
      out.mainBranch = s.mainBranch
      notes.push(`main 브랜치를 저장소의 기본 브랜치 ${s.mainBranch} 로 맞췄습니다(고급 설정).`)
    } else notes.push(`저장소의 기본 브랜치는 ${s.mainBranch} 인데 설정의 main 브랜치는 ${now} 입니다. 그대로 뒀습니다.`)
  }
  if (!s.mappings.some((m) => cleanRemote(m.remote) === '/'))
    notes.push('화면 폴더(src/main/webapp, WebContent)를 찾지 못했습니다. 화면 파일의 경로 매핑은 직접 넣으세요.')
  return { target: out, notes }
}
