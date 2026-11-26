// netrc 읽기(옮기는 동안의 legacyNetrc). 엔진이 한 번 읽어 대상 호스트의 사용자 이름·비밀번호를 정하고, curl 에는 자격 증명
// 관리자와 같은 길(-K - stdin)로 그 값을 넘긴다. curl 이 netrc 를 따로 읽지 않으므로, 계정 지문은 늘 실제로 보낸 사용자
// 이름으로 만든다(ADR 0006).
//
// 엄격하게 읽는다. 흔한 netrc 모양만 받고, 이상한 모양은 고르지 않고 멈춘다(문구에는 줄 번호·이유·netrc 경로만, 값은 없음):
// - 낱말은 공백·탭으로 나눈다. 큰따옴표 값은 안의 공백도 값이고 \ 는 다음 글자를 그대로 넣는다(\n·\r·\t 는 제어 문자라 멈춤).
// - 줄 머리(앞 공백 뒤)의 # 는 그 줄 끝까지 주석이다. 줄 가운데의 # 는 모르는 낱말이라 멈춘다.
// - 항목은 machine <호스트> 또는 default 로 시작하고, 안에는 login <값>·password <값> 만 둘 수 있다. 값 자리의 낱말은
//   키워드처럼 보여도 값이다(password login, login macdef 등). 키워드·호스트는 대소문자를 무시한다. 값은 글자 그대로다.
// - macdef <이름> 은 항목 밖이나 login·password 를 다 적은 항목 뒤에만 둔다. 다음 줄부터 빈 줄(공백·탭만 있는 줄 포함)까지가
//   본문이라 읽지 않는다.
// - 대상 호스트의 machine 항목을 쓰고, 없으면 default 를 쓴다(default 가 앞에 있어도 machine 이 이긴다).
// 멈추는 것: 대상 호스트의 machine 항목이 둘 이상, default 가 둘 이상, 한 항목에 login·password 가 두 번, 모르는 낱말
// (account 포함), 항목 밖의 login·password, login·password 를 다 적기 전의 macdef, 값이 없는 키워드, 닫지 않은 따옴표,
// 낱말 가운데·닫는 따옴표 바로 뒤의 따옴표·글자, 파일 어디든 제어 문자(C0·DEL·C1 U+0080–U+009F. 구분자로 쓴 탭과 줄 끝 CR
// 만 된다), 이스케이프를 푼 값 안의 제어 문자(탭 포함), 빈 호스트(machine ""), UTF-8 로 읽을 수 없는 줄, 대상 항목에
// login 이나 password 가 없음, 고른 항목의 login 에 콜론. 대상과 상관없는 항목의 오류도 멈춘다.
// BOM 은 파일 맨 처음 것만 빼고, 그 밖의 U+FEFF 는 값의 글자로 둔다.
// curl 과 다를 수 있는 점: curl 은 위에서 멈추는 모양 가운데 여럿을 받아들이고 판마다 다르게 읽는다(예: login·password 를 다
// 적은 뒤의 낱말, 같은 호스트 항목 둘, default 가 앞에 있을 때). 엔진은 그런 파일로는 접속하지 않으므로, curl 이 쓰던 netrc
// 라도 고치거나 자격 증명 관리자로 옮겨야 할 수 있다.
import { readFileSync } from 'node:fs'
import { Stop } from './util.ts'

export type NetrcLogin = { user: string; password: string }

/**
 * curl 에는 user = "이름:비밀번호" 로 넘기고 curl 은 첫 콜론에서 나눈다. 그래서 이름에 콜론이 있으면 의도한 계정으로 로그인하지
 * 않고 지문도 보낸 이름과 달라진다: 자격 증명 관리자·netrc 어느 쪽이든 멈춘다(ftp.ts resolveAuth). 비밀번호의 콜론은 괜찮다.
 */
export const USER_COLON = '사용자 이름에 콜론이 있음(curl 이 첫 콜론에서 이름과 비밀번호를 나눠 다른 계정으로 로그인함)'

type Entry = { line: number; host: string | null; user?: string; userLine?: number; password?: string }

/** netrc 내용(바이트 또는 글자)에서 그 호스트의 login·password. 이상한 모양이면 Stop(줄 번호·이유·netrc 경로, 값은 없음). */
export function parseNetrc(input: Buffer | string, host: string, name: string): NetrcLogin {
  const where = `netrc ${name}`
  const fail = (line: number, why: string): never => {
    throw new Stop(`netrc 를 쓸 수 없음 — ${line}행: ${why} (${where}). netrc 를 고치거나 자격 증명 관리자로 옮기세요`)
  }
  let text: string
  if (typeof input === 'string') text = input
  else {
    // 줄마다 풀어 UTF-8 로 못 읽는 첫 줄의 번호를 준다(0x0a 바이트는 UTF-8 의 여러 바이트 글자 안에 나오지 않는다).
    // ignoreBOM: 줄마다 새로 풀어도 줄 머리의 U+FEFF 를 지우지 않는다. BOM 은 아래에서 파일 맨 처음 것만 뺀다.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const parts: string[] = []
    let start = 0
    for (let n = 1; ; n++) {
      const end = input.indexOf(0x0a, start)
      try {
        parts.push(decoder.decode(input.subarray(start, end === -1 ? input.length : end)))
      } catch {
        fail(n, 'UTF-8 로 읽을 수 없음(UTF-8 로 저장하세요)')
      }
      if (end === -1) break
      start = end + 1
    }
    text = parts.join('\n')
  }
  // 파일 맨 처음의 BOM 만 뺀다. 그 밖의 U+FEFF 는 값의 글자로 둔다(보낸 이름 그대로 지문을 만든다).
  if (text.startsWith('﻿')) text = text.slice(1)

  const entries: Entry[] = []
  let entry: Entry | null = null
  /** 다음 낱말이 무엇이어야 하나: 키워드 자리, machine 의 호스트, login·password 의 값, macdef 의 이름. */
  let want: 'key' | 'host' | 'user' | 'password' | 'macro' = 'key'
  let wantLine = 0
  let macroLine = false
  let inMacro = false

  const lines = text.split('\n')
  for (const [i, raw] of lines.entries()) {
    const n = i + 1
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (/[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(line)) fail(n, '제어 문자가 있음')
    if (inMacro) {
      if (/^[ \t]*$/.test(line)) inMacro = false
      continue
    }
    let p = 0
    let first = true
    while (p < line.length) {
      while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++
      if (p >= line.length) break
      if (first && line[p] === '#') break
      first = false
      let tok = ''
      let quoted = false
      if (line[p] === '"') {
        quoted = true
        let closed = false
        for (p++; p < line.length; ) {
          const c = line[p++]
          if (c === '"') {
            closed = true
            break
          }
          if (c === '\t') fail(n, '따옴표 값 안에 탭이 있음')
          if (c !== '\\') {
            tok += c
            continue
          }
          if (p >= line.length) fail(n, '따옴표 안의 \\ 뒤에 글자가 없음')
          const e = line[p++]
          if (e === 'n' || e === 'r' || e === 't') fail(n, '따옴표 안에 제어 문자(\\n·\\r·\\t)가 있음')
          tok += e
        }
        if (!closed) fail(n, '따옴표를 닫지 않음')
        if (p < line.length && line[p] !== ' ' && line[p] !== '\t') fail(n, '닫는 따옴표 바로 뒤에 글자가 있음')
      } else {
        while (p < line.length && line[p] !== ' ' && line[p] !== '\t') tok += line[p++]
        if (tok.includes('"')) fail(n, '낱말 가운데에 따옴표가 있음')
      }
      // 이스케이프를 푼 최종 값에도 제어 문자(탭 포함)가 없어야 한다(따옴표 안 \ 뒤의 실제 탭 등).
      if (/[\x00-\x1f\x7f-\x9f]/.test(tok)) fail(n, '값에 제어 문자(탭 포함)가 있음')

      if (macroLine) fail(n, 'macdef 줄에 이름 밖의 낱말이 있음')
      if (want === 'host') {
        if (!tok) fail(n, 'machine 의 호스트가 비었음')
        entry!.host = tok.toLowerCase()
        want = 'key'
        continue
      }
      if (want === 'user' || want === 'password') {
        if (want === 'user') {
          entry!.user = tok
          entry!.userLine = n
        }
        else entry!.password = tok
        want = 'key'
        continue
      }
      if (want === 'macro') {
        macroLine = true
        want = 'key'
        continue
      }
      const word = quoted ? '' : tok.toLowerCase()
      if (word === 'machine' || word === 'default') {
        if (word === 'default' && entries.some((x) => x.host === null)) fail(n, 'default 항목이 둘 이상')
        entry = { line: n, host: null }
        entries.push(entry)
        if (word === 'machine') {
          want = 'host'
          wantLine = n
        }
      } else if (word === 'login' || word === 'password') {
        if (!entry) fail(n, `항목 밖의 ${word}(앞에 machine·default 가 없음)`)
        if ((word === 'login' ? entry!.user : entry!.password) !== undefined) fail(n, `한 항목에 ${word === 'login' ? 'login 을' : 'password 를'} 두 번 적음`)
        want = word === 'login' ? 'user' : 'password'
        wantLine = n
      } else if (word === 'macdef') {
        if (entry && (entry.user === undefined || entry.password === undefined))
          fail(n, '항목 안의 macdef(login·password 를 다 적기 전)')
        entry = null
        want = 'macro'
        wantLine = n
      } else fail(n, '모르는 낱말')
    }
    if (macroLine) {
      macroLine = false
      inMacro = true
    }
  }
  if (want === 'host') fail(wantLine, 'machine 뒤에 호스트가 없음')
  if (want === 'user' || want === 'password') fail(wantLine, `${want === 'user' ? 'login' : 'password'} 뒤에 값이 없음`)
  if (want === 'macro') fail(wantLine, 'macdef 뒤에 이름이 없음')

  const target = host.toLowerCase()
  const hits = entries.filter((x) => x.host === target)
  if (hits.length > 1) fail(hits[1].line, `대상 호스트(${target}) 항목이 둘 이상`)
  const chosen = hits[0] ?? entries.find((x) => x.host === null)
  if (!chosen) throw new Stop(`netrc 에 ${target} 항목이 없음(machine·default) (${where})`)
  if (!chosen.user) throw new Stop(`netrc 에 ${target} 의 login 이 없음(${chosen.line}행 항목) (${where})`)
  if (chosen.password === undefined) throw new Stop(`netrc 에 ${target} 의 password 가 없음(${chosen.line}행 항목) (${where})`)
  if (chosen.user.includes(':')) fail(chosen.userLine!, USER_COLON)
  return { user: chosen.user, password: chosen.password }
}

/** netrc 파일을 읽어 그 호스트의 login·password. 이상한 모양이면 멈춘다. */
export function readNetrc(file: string, host: string, name = file): NetrcLogin {
  return parseNetrc(readFileSync(file), host, name)
}
