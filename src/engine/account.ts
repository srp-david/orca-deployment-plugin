// FTP 계정 지문: 업로드한 계정을 run 기록(upload.account)에 남길 때 쓴다. 같은 대상이라도 계정마다 루트(chroot)가 달라
// 같은 운영 경로가 다른 파일일 수 있어서, 백업 정리와 되돌리기의 "나중에 올린 run" 판정이 계정을 가린다(ADR 0006).
// 지문에는 비밀번호를 넣지 않고, 사용자 이름도 그대로 남기지 않는다(sha256 앞 16자).
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FtpAuth } from './ftp.ts'
import type { Target } from './target.ts'
import { sha256 } from './util.ts'

/** netrc 에서 그 호스트 항목(machine <호스트>)의 login 만 읽는다. 비밀번호 칸은 보지 않는다. 없으면 null. */
function netrcLogin(file: string, host: string): string | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  // 낱말을 "이름 값" 짝으로 읽는다(default 만 값이 없다): 비밀번호 값이 login 같은 낱말이어도 이름으로 읽지 않게.
  const tok = text.split(/\s+/).filter(Boolean)
  let mine = false
  for (let i = 0; i < tok.length; i++) {
    const key = tok[i]
    if (key === 'default') {
      mine = false
      continue
    }
    const value = tok[++i] ?? ''
    if (key === 'machine') mine = value.toLowerCase() === host
    else if (mine && key === 'login' && value) return value
  }
  return null
}

/**
 * 계정 지문 = sha256("prod-deploy account\n" + 호스트(소문자) + ":" + 포트 + "\n" + 사용자 이름) 앞 16자.
 * 사용자 이름은 resolveAuth 가 돌려준 접속 정보에서: 자격 증명 관리자면 그 사용자, netrc 면 대상 호스트의 login.
 * netrc 에서 이름을 찾지 못하면 "netrc:<경로>" 로 대신한다(같은 파일이면 같은 계정으로 본다).
 */
export function accountMark(t: Target, auth: FtpAuth, netrcName = auth.kind === 'netrc' ? auth.file : ''): string {
  const host = t.connection.host.toLowerCase()
  const port = t.connection.port ?? 21
  const user = auth.kind === 'user' ? auth.user : (netrcLogin(auth.file, host) ?? `netrc:${netrcName}`)
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
