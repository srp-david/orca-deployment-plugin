// 시험용 class 파일 만들기(javac 없이). 상위 class·인터페이스·필드(ConstantValue)·SourceFile 만 넣는다.
// 문자열은 class 파일 규칙대로 Modified UTF-8 로 쓴다.

export type FixField = { name: string; desc: string; value?: number | string | bigint; access?: number }
export type FixOpts = { superName?: string; interfaces?: string[]; sourceFile?: string; major?: number }

export const PUBLIC_STATIC_FINAL = 0x0019
export const PRIVATE_STATIC_FINAL = 0x001a
export const PUBLIC_STATIC = 0x0009

/** UTF-16 코드 단위마다: NUL 은 C0 80, 그 밖은 1~3바이트(대리 쌍은 반쪽씩 3바이트). */
export function encodeMutf8(s: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c !== 0 && c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return Buffer.from(out)
}

/** `com/x/Foo` 같은 내부 이름의 class. tag 는 상수 풀에 글자로 들어가 파일을 구분하는 데 쓴다. */
export function makeClass(name: string, fields: FixField[] = [], tag = '', opts: FixOpts = {}): Buffer {
  const pool: Buffer[] = []
  let next = 1
  const add = (b: Buffer, slots = 1) => {
    pool.push(b)
    const i = next
    next += slots
    return i
  }
  const u2 = (n: number) => {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(n)
    return b
  }
  const u4 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const utf8 = (s: string) => {
    const bytes = encodeMutf8(s)
    return add(Buffer.concat([Buffer.from([1]), u2(bytes.length), bytes]))
  }
  const cls = (s: string) => add(Buffer.concat([Buffer.from([7]), u2(utf8(s))]))
  const value = (desc: string, v: number | string | bigint): number => {
    if (desc === 'Ljava/lang/String;') return add(Buffer.concat([Buffer.from([8]), u2(utf8(String(v)))]))
    if (desc === 'J') {
      const b = Buffer.alloc(9)
      b[0] = 5
      b.writeBigInt64BE(BigInt(v), 1)
      return add(b, 2)
    }
    if (desc === 'D') {
      const b = Buffer.alloc(9)
      b[0] = 6
      b.writeDoubleBE(Number(v), 1)
      return add(b, 2)
    }
    if (desc === 'F') {
      const b = Buffer.alloc(5)
      b[0] = 4
      b.writeFloatBE(Number(v), 1)
      return add(b)
    }
    const b = Buffer.alloc(5)
    b[0] = 3
    b.writeInt32BE(Number(v), 1)
    return add(b)
  }

  const self = cls(name)
  const sup = cls(opts.superName ?? 'java/lang/Object')
  const ifaces = (opts.interfaces ?? []).map(cls)
  if (tag) utf8(tag)
  const cv = utf8('ConstantValue')
  const fieldBytes = fields.map((f) => {
    const n = utf8(f.name)
    const d = utf8(f.desc)
    const parts = [u2(f.access ?? PUBLIC_STATIC_FINAL), u2(n), u2(d)]
    if (f.value === undefined) parts.push(u2(0))
    else parts.push(u2(1), u2(cv), u4(2), u2(value(f.desc, f.value)))
    return Buffer.concat(parts)
  })
  const classAttrs: Buffer[] = []
  if (opts.sourceFile) {
    const sfName = utf8('SourceFile')
    const sf = utf8(opts.sourceFile)
    classAttrs.push(Buffer.concat([u2(sfName), u4(2), u2(sf)]))
  }
  const head = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, opts.major ?? 52])
  return Buffer.concat([
    head,
    u2(next),
    ...pool,
    u2(0x21),
    u2(self),
    u2(sup),
    u2(ifaces.length),
    ...ifaces.map(u2),
    u2(fields.length),
    ...fieldBytes,
    u2(0),
    u2(classAttrs.length),
    ...classAttrs
  ])
}
