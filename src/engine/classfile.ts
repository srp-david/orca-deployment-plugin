// class 파일 읽기: 이름·상위 class·인터페이스·소스 파일 이름, 그리고 컴파일 시간 상수(ConstantValue 가 붙은 final 필드).
// 컴파일 시간 상수는 쓰는 쪽 class 에 값이 복사돼 들어간다(JLS 13.1). 값이 바뀌면 쓰는 class 도 다시 올려야 한다.
// 형식: JVMS 4 (https://docs.oracle.com/javase/specs/jvms/se8/html/jvms-4.html)

export type ConstField = {
  /** 필드 이름 */
  name: string
  /** 필드 형식(JVM 표기, 예: I, Ljava/lang/String;) */
  desc: string
  /** 비교용 값(형식 태그 + 원래 바이트) */
  key: string
  /** 사람이 읽을 값 */
  shown: string
  /** private 이면 같은 소스 파일 밖에서 쓸 수 없다 */
  private: boolean
}

export type ClassInfo = {
  /** 내부 이름(예: com/x/Foo$Inner) */
  name: string
  major: number
  superName: string | null
  interfaces: string[]
  /** SourceFile 속성(예: Foo.java). 없으면 null */
  sourceFile: string | null
  constants: ConstField[]
}

const ACC_PRIVATE = 0x0002
const ACC_FINAL = 0x0010

type Entry = { tag: number; a: number; b: number; bytes?: Buffer }

/** 상수 값 태그가 필드 형식과 맞는가 (JVMS 4.7.2). */
const VALUE_TAG: Record<string, number> = { I: 3, S: 3, C: 3, B: 3, Z: 3, F: 4, J: 5, D: 6, 'Ljava/lang/String;': 8 }

/**
 * class 파일의 문자열은 Modified UTF-8 이다(JVMS 4.4.7): NUL 은 C0 80, BMP 밖 글자는 대리 쌍을 각각 3바이트로.
 * 바이트를 UTF-16 코드 단위로 그대로 풀면 대리 쌍도 자연히 맞춰진다.
 */
export function decodeMutf8(b: Buffer): string {
  let s = ''
  for (let i = 0; i < b.length; ) {
    const x = b[i]
    if (x < 0x80) {
      if (x === 0) throw new Error('class 문자열 형식이 틀림')
      s += String.fromCharCode(x)
      i += 1
    } else if ((x & 0xe0) === 0xc0 && i + 1 < b.length && (b[i + 1] & 0xc0) === 0x80) {
      const c = ((x & 0x1f) << 6) | (b[i + 1] & 0x3f)
      // 2바이트는 NUL 또는 0x80 이상만(더 짧게 쓸 수 있는 글자를 길게 쓴 것은 틀림)
      if (c !== 0 && c < 0x80) throw new Error('class 문자열 형식이 틀림')
      s += String.fromCharCode(c)
      i += 2
    } else if ((x & 0xf0) === 0xe0 && i + 2 < b.length && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) {
      const c = ((x & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)
      if (c < 0x800) throw new Error('class 문자열 형식이 틀림')
      s += String.fromCharCode(c)
      i += 3
    } else throw new Error('class 문자열 형식이 틀림')
  }
  return s
}

/** class 파일을 끝까지 읽는다. 형식이 틀리거나 잘렸으면 Error. */
export function readClass(buf: Buffer): ClassInfo {
  let p = 0
  const need = (n: number) => {
    if (p + n > buf.length) throw new Error('class 파일이 잘림')
  }
  const u1 = () => (need(1), buf.readUInt8(p++))
  const u2 = () => {
    need(2)
    const v = buf.readUInt16BE(p)
    p += 2
    return v
  }
  const u4 = () => {
    need(4)
    const v = buf.readUInt32BE(p)
    p += 4
    return v
  }
  if (u4() !== 0xcafebabe) throw new Error('class 파일이 아님')
  u2()
  const major = u2()
  const count = u2()
  const pool: (Entry | undefined)[] = [undefined]
  for (let i = 1; i < count; i++) {
    const tag = u1()
    switch (tag) {
      case 1: {
        const len = u2()
        need(len)
        pool[i] = { tag, a: 0, b: 0, bytes: buf.subarray(p, p + len) }
        p += len
        break
      }
      case 3:
      case 4:
        need(4)
        pool[i] = { tag, a: 0, b: 0, bytes: buf.subarray(p, p + 4) }
        p += 4
        break
      case 5:
      case 6:
        // long·double 은 두 칸을 차지한다(JVMS 4.4.5).
        need(8)
        pool[i] = { tag, a: 0, b: 0, bytes: buf.subarray(p, p + 8) }
        p += 8
        pool[++i] = undefined
        break
      case 7:
      case 8:
      case 16:
      case 19:
      case 20:
        pool[i] = { tag, a: u2(), b: 0 }
        break
      case 15:
        pool[i] = { tag, a: u1(), b: u2() }
        break
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        pool[i] = { tag, a: u2(), b: u2() }
        break
      default:
        throw new Error(`class 상수 풀 형식이 틀림(${tag})`)
    }
  }
  const entry = (i: number, tag: number): Entry => {
    const e = pool[i]
    if (!e || e.tag !== tag) throw new Error('class 상수 풀 참조가 틀림')
    return e
  }
  const utf8 = (i: number): string => decodeMutf8(entry(i, 1).bytes!)
  const className = (i: number): string => utf8(entry(i, 7).a)

  u2() // access
  const name = className(u2())
  const sup = u2()
  const superName = sup === 0 ? null : className(sup)
  const interfaces: string[] = []
  for (let n = u2(); n > 0; n--) interfaces.push(className(u2()))

  const constants: ConstField[] = []
  for (let n = u2(); n > 0; n--) {
    const access = u2()
    const fname = utf8(u2())
    const desc = utf8(u2())
    for (let a = u2(); a > 0; a--) {
      const an = utf8(u2())
      const len = u4()
      need(len)
      if (an === 'ConstantValue') {
        if (len !== 2) throw new Error(`ConstantValue 길이가 틀림: ${fname}`)
        const v = pool[buf.readUInt16BE(p)]
        if (!v || VALUE_TAG[desc] !== v.tag) throw new Error(`상수 값 형식이 필드와 맞지 않음: ${fname}`)
        // 문자열 상수는 Utf8 칸을 가리키고, 나머지는 값 바이트를 직접 갖는다.
        const raw = v.tag === 8 ? entry(v.a, 1).bytes! : v.bytes!
        // 컴파일 시간 상수(쓰는 쪽에 값이 복사되는 것)는 final 필드뿐이다(JLS 4.12.4). javac 는 final 에만 붙인다.
        if (access & ACC_FINAL)
          constants.push({ name: fname, desc, key: `${v.tag}:${raw.toString('hex')}`, shown: show(v, raw, desc), private: !!(access & ACC_PRIVATE) })
      }
      p += len
    }
  }
  // 메서드는 건너뛴다(속성 길이로).
  for (let n = u2(); n > 0; n--) {
    p += 6
    for (let a = u2(); a > 0; a--) {
      u2()
      const len = u4()
      need(len)
      p += len
    }
  }
  let sourceFile: string | null = null
  for (let a = u2(); a > 0; a--) {
    const an = utf8(u2())
    const len = u4()
    need(len)
    if (an === 'SourceFile') {
      if (len !== 2) throw new Error('SourceFile 길이가 틀림')
      sourceFile = utf8(buf.readUInt16BE(p))
    }
    p += len
  }
  if (p !== buf.length) throw new Error('class 파일 끝에 남는 바이트가 있음')
  return { name, major, superName, interfaces, sourceFile, constants }
}

function show(v: Entry, raw: Buffer, desc: string): string {
  switch (v.tag) {
    case 3: {
      const n = raw.readInt32BE(0)
      if (desc === 'Z') return n ? 'true' : 'false'
      if (desc === 'C') return JSON.stringify(String.fromCharCode(n))
      return String(n)
    }
    case 4:
      return String(raw.readFloatBE(0))
    case 5:
      return raw.readBigInt64BE(0).toString() + 'L'
    case 6:
      return String(raw.readDoubleBE(0))
    case 8: {
      const s = decodeMutf8(raw)
      return JSON.stringify(s.length > 40 ? s.slice(0, 40) + '…' : s)
    }
  }
  return '?'
}

export type ConstChange = { name: string; before: string; after: string }

/**
 * 운영 class 기준으로, 밖에서 쓸 수 있던 상수 중 값이 바뀌었거나 더는 상수가 아닌 것.
 * 상수가 일반 필드가 되거나 없어져도 쓰는 class 에는 옛 값이 복사돼 남아 있으므로 바뀐 것으로 본다.
 * private 상수와 새로 생긴 상수는 뺀다(밖에서 옛 값을 가진 class 가 없음).
 */
export function changedConstants(before: ClassInfo, after: ClassInfo): ConstChange[] {
  const now = new Map(after.constants.map((c) => [c.name, c]))
  const out: ConstChange[] = []
  for (const o of before.constants) {
    if (o.private) continue
    const c = now.get(o.name)
    if (!c) out.push({ name: o.name, before: o.shown, after: '상수 아님' })
    else if (o.desc !== c.desc || o.key !== c.key) out.push({ name: o.name, before: o.shown, after: c.shown })
  }
  return out
}
