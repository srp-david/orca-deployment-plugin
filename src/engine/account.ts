// FTP 계정 지문: 업로드한 계정을 run 기록(upload.account)에 남길 때 쓴다. 같은 대상이라도 계정마다 루트(chroot)가 달라
// 같은 운영 경로가 다른 파일일 수 있어서, 백업 정리와 되돌리기의 "나중에 올린 run" 판정이 계정을 가린다(ADR 0006).
// 지문에는 비밀번호를 넣지 않고, 사용자 이름도 그대로 남기지 않는다(sha256 앞 16자).
import type { FtpAuth } from './ftp.ts'
import type { Target } from './target.ts'
import { sha256 } from './util.ts'

/**
 * 계정 지문 = sha256("prod-deploy account\n" + 호스트(소문자) + ":" + 포트 + "\n" + 사용자 이름) 앞 16자.
 * 사용자 이름은 resolveAuth 가 돌려준, curl 로 실제로 보내는 값이다(자격 증명 관리자든 netrc 든). 앞뒤 공백만 빼고 글자
 * 그대로 쓴다(대소문자 구분).
 */
export function accountMark(t: Target, auth: FtpAuth): string {
  const host = t.connection.host.toLowerCase()
  const port = t.connection.port ?? 21
  return sha256(`prod-deploy account\n${host}:${port}\n${auth.user.trim()}`).slice(0, 16)
}

/**
 * 두 run 을 같은 계정으로 올렸다고 보는가. 지문이 없는 run(지문을 남기기 전 기록)은 어느 run 과도 같은 계정으로 본다:
 * 그런 run 은 지문을 남기기 전과 똑같이 다룬다.
 */
export function sameAccount(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b
}
