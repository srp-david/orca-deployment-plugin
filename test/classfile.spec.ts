import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changedConstants, decodeMutf8, readClass } from '../src/engine/classfile.ts'
import { makeClass, PRIVATE_STATIC_FINAL, PUBLIC_STATIC } from './class-fixture.ts'

const S = 'Ljava/lang/String;'

test('class 이름·major·상위·인터페이스·소스 파일·상수를 읽는다', () => {
  const c = readClass(
    makeClass(
      'com/x/Foo',
      [
        { name: 'LIMIT', desc: 'I', value: 3 },
        { name: 'NAME', desc: S, value: '가나' },
        { name: 'BIG', desc: 'J', value: 9n },
        { name: 'RATE', desc: 'D', value: 0.5 },
        { name: 'SECRET', desc: 'I', value: 1, access: PRIVATE_STATIC_FINAL },
        { name: 'list', desc: 'Ljava/util/List;' }
      ],
      '',
      { superName: 'com/x/Base', interfaces: ['com/x/Api'], sourceFile: 'Foo.java' }
    )
  )
  assert.equal(c.name, 'com/x/Foo')
  assert.equal(c.major, 52)
  assert.equal(c.superName, 'com/x/Base')
  assert.deepEqual(c.interfaces, ['com/x/Api'])
  assert.equal(c.sourceFile, 'Foo.java')
  assert.deepEqual(
    c.constants.map((x) => [x.name, x.shown, x.private]),
    [
      ['LIMIT', '3', false],
      ['NAME', '"가나"', false],
      ['BIG', '9L', false],
      ['RATE', '0.5', false],
      ['SECRET', '1', true]
    ]
  )
})

test('바뀐 상수: 값이 바뀜·상수가 아니게 됨·없어짐을 잡고, private·새로 생긴 상수는 뺀다', () => {
  const before = readClass(
    makeClass('com/x/Foo', [
      { name: 'LIMIT', desc: 'I', value: 1 },
      { name: 'SAME', desc: S, value: 'a' },
      { name: 'SECRET', desc: 'I', value: 1, access: PRIVATE_STATIC_FINAL },
      { name: 'URL', desc: S, value: 'http://old' },
      { name: 'LOADED', desc: 'I', value: 5 },
      { name: 'GONE', desc: 'I', value: 6 }
    ])
  )
  const after = readClass(
    makeClass('com/x/Foo', [
      { name: 'LIMIT', desc: 'I', value: 2 },
      { name: 'SAME', desc: S, value: 'a' },
      { name: 'SECRET', desc: 'I', value: 2, access: PRIVATE_STATIC_FINAL },
      { name: 'URL', desc: S, value: 'http://new' },
      // final 이 빠지거나 실행 중에 값을 정하면 ConstantValue 가 없어진다
      { name: 'LOADED', desc: 'I', access: PUBLIC_STATIC },
      { name: 'ADDED', desc: 'I', value: 7 }
    ])
  )
  assert.deepEqual(changedConstants(before, after), [
    { name: 'LIMIT', before: '1', after: '2' },
    { name: 'URL', before: '"http://old"', after: '"http://new"' },
    { name: 'LOADED', before: '5', after: '상수 아님' },
    { name: 'GONE', before: '6', after: '상수 아님' }
  ])
  assert.deepEqual(changedConstants(after, after), [])
})

test('Modified UTF-8: NUL(C0 80)과 BMP 밖 글자(대리 쌍 6바이트)를 바로 푼다', () => {
  assert.equal(decodeMutf8(Buffer.from([0x41, 0xc0, 0x80, 0x42])), 'A\u0000B')
  assert.equal(decodeMutf8(Buffer.from([0xed, 0xa0, 0x81, 0xed, 0xb0, 0x80])), '\u{10400}')
  assert.equal(decodeMutf8(Buffer.from('가', 'utf8')), '가')
  assert.throws(() => decodeMutf8(Buffer.from([0x00])), /문자열 형식/)
  // 더 짧게 쓸 수 있는 글자를 길게 쓴 것(overlong)은 틀림
  assert.throws(() => decodeMutf8(Buffer.from([0xc1, 0x81])), /문자열 형식/)
  assert.throws(() => decodeMutf8(Buffer.from([0xe0, 0x81, 0x81])), /문자열 형식/)
  const c = readClass(makeClass('com/x/Foo', [{ name: 'Z\u{10400}', desc: S, value: 'a\u0000b' }]))
  assert.equal(c.constants[0].name, 'Z\u{10400}')
  assert.equal(c.constants[0].shown, JSON.stringify('a\u0000b'))
})

test('class 가 아니거나 어디가 잘렸거나 남는 바이트가 있으면 읽지 않는다', () => {
  assert.throws(() => readClass(Buffer.from('not a class')), /class 파일이 아님/)
  const ok = makeClass('com/x/Foo', [{ name: 'A', desc: 'I', value: 1 }], '', { sourceFile: 'Foo.java' })
  assert.doesNotThrow(() => readClass(ok))
  // 끝에서부터 한 바이트씩 잘라도(필드 뒤 메서드 수·class 속성까지) 모두 실패해야 한다
  for (let cut = 1; cut < ok.length - 10; cut++) assert.throws(() => readClass(ok.subarray(0, ok.length - cut)), undefined, `cut ${cut}`)
  assert.throws(() => readClass(Buffer.concat([ok, Buffer.from([0])])), /남는 바이트/)
})

test('상수 값 형식이 필드 형식과 다르면 읽지 않는다', () => {
  // List 필드에 Integer ConstantValue 를 붙인 class: fixture 는 String 이 아닌 형식에 Integer 를 넣는다
  const bad = makeClass('com/x/Foo', [{ name: 'L', desc: 'Ljava/util/List;', value: 1 }])
  assert.throws(() => readClass(bad), /상수 값 형식이 필드와 맞지 않음/)
})
