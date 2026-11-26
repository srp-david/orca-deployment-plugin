// FTP 계정 지문: 업로드한 계정을 run 기록(upload.account)에 남길 때 쓴다. 같은 대상이라도 계정마다 루트(chroot)가 달라
// 같은 운영 경로가 다른 파일일 수 있어서, 백업 정리와 되돌리기의 "나중에 올린 run" 판정이 계정을 가린다(ADR 0006).
// 지문에는 비밀번호를 넣지 않고, 사용자 이름도 그대로 남기지 않는다(sha256 앞 16자).
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FtpAuth } from './ftp.ts'
import type { Target } from './target.ts'
import { sha256 } from './util.ts'

// netrc 는 curl 이 읽는 뜻 그대로 읽는다(접속은 curl 이 그 파일로 한다). 엔진은 PATH 의 첫 curl 을 쓰므로, 이 PC 의 두 curl
// (Git for Windows 의 8.19.0, Windows 기본 System32 의 8.21.0)에 여러 모양의 netrc 를 주고 실제로 보내는 USER 를
// `curl -v` 로 보아 맞췄다.
// 두 판이 같게 읽는 것:
// - 줄 머리(앞 공백 뒤)의 # 는 그 줄 끝까지 주석이다. 줄 가운데의 # 는 보통 낱말이다.
// - 큰따옴표 값: 안의 공백도 값이고, \ 는 다음 글자를 그대로 넣는다(\n·\r·\t 는 제어 문자라 curl 이 오류로 멈춤). 닫지 않으면 오류.
// - 키워드(machine·default·login·password·macdef)와 호스트는 대소문자를 무시한다. login 값은 글자 그대로다.
// - login·password 다음 낱말은 그 값이다(비밀번호 값을 키워드로 읽지 않는다). 한 항목에서 login 이 두 번이면 뒤 것.
// - 항목 밖의 macdef 는 다음 줄부터 빈 줄(공백만 있는 줄도)까지가 본문이라 읽지 않는다.
// - 앞에 맞는 machine 이 없으면 default 항목을 쓴다. 같은 호스트 항목이 둘이면 login·password 가 다 있는 앞 항목.
// 두 판이 다르게 읽는 것(그래서 두 해석을 함께 지문에 넣는다, ADR 0006 "계정 지문의 한계"):
// - 8.19 는 login·password 를 다 찾으면 바로 멈춘다. 8.21 은 다음 machine·default·macdef 까지 읽고 뒤 값으로 바꾼다.
// - password 없이 다음 machine·default 를 만나면 8.19 는 찾은 login 을 버리고 이어 찾고, 8.21 은 거기서 멈춘다.
// - 항목 안의 macdef 는 8.19 가 모르는 낱말로 넘기고, 8.21 은 매크로로 읽어 그 항목을 버린다.
// - account 는 8.21 만 키워드로 알아 다음 낱말을 값으로 먹는다. macdef 줄의 빈 값("")은 8.19 에서 매크로를 끝낸다.

type CurlVersion = '8.19' | '8.21'
const BLANK = /[ \t\r\n\f\v]/

/** 한 줄을 curl 처럼 낱말로 나눈다. 줄 머리 # 면 빈 목록, 따옴표를 닫지 않았으면 null(curl 오류). */
function lineTokens(line: string): string[] | null {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && BLANK.test(line[i])) i++
    if (i >= line.length) break
    if (out.length === 0 && line[i] === '#') break
    let s = ''
    if (line[i] === '"') {
      let closed = false
      for (i++; i < line.length; ) {
        const c = line[i++]
        if (c === '"') {
          closed = true
          break
        }
        if (c === '\\') {
          if (i >= line.length) return null
          const e = line[i++]
          s += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e
        } else s += c
      }
      if (!closed) return null
    } else while (i < line.length && !BLANK.test(line[i])) s += line[i++]
    out.push(s)
  }
  return out
}

/** 그 curl 판이 그 호스트에 쓸 login. 찾지 못하거나 curl 이 오류로 멈출 모양이면 null. 비밀번호 값은 오류 확인에만 쓴다. */
function curlLogin(text: string, host: string, v: CurlVersion): string | null {
  let state: 'none' | 'macdef' | 'hostfound' | 'hostvalid' = 'none'
  let login: string | null = null
  let password: string | null = null
  let key: 'login' | 'password' | 'account' | null = null
  const result = () => ([login, password].some((x) => x !== null && /[\x00-\x1f\x7f]/.test(x)) ? null : login || null)
  for (const line of text.split('\n')) {
    if (state === 'macdef') {
      if (!line.trim()) state = 'none'
      continue
    }
    const toks = lineTokens(line)
    if (!toks) return null
    for (const tok of toks) {
      const word = tok.toLowerCase()
      if (v === '8.19' && state === 'hostvalid' && login && password) return result()
      if (state === 'none') {
        if (word === 'macdef') state = 'macdef'
        else if (word === 'machine') state = 'hostfound'
        else if (word === 'default') state = 'hostvalid'
      } else if (state === 'macdef') {
        if (v === '8.19' && tok === '') state = 'none'
      } else if (state === 'hostfound') state = word === host ? 'hostvalid' : 'none'
      else if (key) {
        if (key === 'login') login = tok
        else if (key === 'password') password = tok
        key = null
      } else if (word === 'login' || word === 'password' || (v === '8.21' && word === 'account')) key = word
      else if (word === 'machine' || word === 'default' || (v === '8.21' && word === 'macdef')) {
        if (v === '8.19' ? password !== null : login !== null || password !== null) return result()
        login = null
        password = null
        state = word === 'machine' ? 'hostfound' : word === 'default' ? 'hostvalid' : 'macdef'
      }
    }
  }
  return result()
}

/**
 * netrc 에서 curl 이 그 호스트에 쓸 사용자 이름(앞뒤 공백 뺌). 못 찾으면 null.
 * 두 curl 판의 해석이 다르면 둘을 함께 적은 글자를 돌려준다: 같은 내용이면 같은 글자, login 을 바꾸면 달라진다.
 */
function netrcUser(file: string, host: string): string | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const [a, b] = (['8.19', '8.21'] as const).map((v) => curlLogin(text, host, v)?.trim() || null)
  if (a === b) return a
  return `netrc curl 8.19=${JSON.stringify(a)} 8.21=${JSON.stringify(b)}`
}

/**
 * 계정 지문 = sha256("prod-deploy account\n" + 호스트(소문자) + ":" + 포트 + "\n" + 사용자 이름) 앞 16자.
 * 사용자 이름은 resolveAuth 가 돌려준 접속 정보에서: 자격 증명 관리자면 그 사용자, netrc 면 curl 이 대상 호스트에 쓸 login.
 * 앞뒤 공백만 빼고 글자 그대로 쓴다(대소문자 구분).
 * netrc 에서 이름을 찾지 못하면 "netrc:<경로>" 로 대신한다(같은 파일이면 같은 계정으로 본다).
 */
export function accountMark(t: Target, auth: FtpAuth, netrcName = auth.kind === 'netrc' ? auth.file : ''): string {
  const host = t.connection.host.toLowerCase()
  const port = t.connection.port ?? 21
  const user = auth.kind === 'user' ? auth.user.trim() : (netrcUser(auth.file, host) ?? `netrc:${netrcName}`)
  return sha256(`prod-deploy account\n${host}:${port}\n${user}`).slice(0, 16)
}

/** 한 번의 업로드에 고정한 접속 정보와 그 계정의 지문. 끝나면(실패해도) release 로 사본을 지운다. */
export type PinnedAccount = { auth: FtpAuth; mark: string; release: () => void }

/**
 * 한 번의 업로드가 쓰는 접속 정보를 지금 값으로 고정한다. curl 은 부를 때마다 netrc 파일을 다시 읽으므로, 업로드 도중 파일이
 * 바뀌면 다른 계정으로 보낼 수 있다. 그래서 netrc 는 OS 임시 폴더에 한 번 복사해 그 업로드의 모든 curl 이 사본을 쓰게 하고,
 * 지문도 그 사본으로 만든다(사본은 run 기록 폴더에 두지 않는다). 자격 증명 관리자 값은 이미 한 번 읽은 값이라 그대로 쓴다.
 */
export function pinAccount(t: Target, auth: FtpAuth): PinnedAccount {
  if (auth.kind === 'user') return { auth, mark: accountMark(t, auth), release: () => {} }
  const dir = mkdtempSync(join(tmpdir(), 'pd-netrc-'))
  const release = () => rmSync(dir, { recursive: true, force: true })
  try {
    const copy = join(dir, 'netrc')
    copyFileSync(auth.file, copy)
    const pinned: FtpAuth = { kind: 'netrc', file: copy }
    // 이름을 찾지 못할 때 대신 쓰는 경로는 원래 netrc 경로(사본 경로는 업로드마다 달라서)
    return { auth: pinned, mark: accountMark(t, pinned, auth.file), release }
  } catch (e) {
    release()
    throw e
  }
}

/**
 * 두 run 을 같은 계정으로 올렸다고 보는가. 지문이 없는 run(지문을 남기기 전 기록)은 어느 run 과도 같은 계정으로 본다:
 * 그런 run 은 지문을 남기기 전과 똑같이 다룬다.
 */
export function sameAccount(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b
}
