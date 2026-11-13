// 접속 확인(로그인 + 운영 루트 목록 조회)의 결과를 사람이 읽을 말로.
// 여기서 말하는 "성공"은 로그인과 그 폴더의 목록 조회까지다. 경로 매핑이 맞는지, 올릴 권한이 있는지는 말하지 않는다.
import type { Probe } from './engine/ftp.ts'
import type { Target } from './engine/target.ts'

export type ConnVerdict = {
  /** ok 성공, empty 로그인은 됐지만 운영 루트가 비어 있음(경로를 의심), failed 실패. */
  result: 'ok' | 'empty' | 'failed'
  message: string
}

export function connVerdict(t: Target, p: Probe, seconds: number): ConnVerdict {
  const c = t.connection
  const root = c.root
  const at = `${c.host}:${c.port ?? 21}`
  if (p.ok) {
    if (p.count === 0)
      return { result: 'empty', message: `로그인은 됐지만 운영 루트(${root})가 비어 있음 — 운영 루트 경로가 맞는지 확인하세요` }
    return {
      result: 'ok',
      message: `로그인과 운영 루트(${root}) 목록 조회 성공 — 항목 ${p.count}개.\n여기까지만 확인했습니다: 경로 매핑이 맞는지는 설정 확인으로 봅니다.`
    }
  }
  const failed = (text: string): ConnVerdict => ({ result: 'failed', message: `${text} [curl ${p.code}]` })
  switch (p.code) {
    case -1:
      return failed(`curl 을 실행하지 못했거나 응답 없이 끝남${p.err ? `: ${p.err}` : ''}`)
    case 6:
      return failed(`서버 이름을 찾지 못함: ${c.host} — 호스트 철자와 사내망·VPN 연결을 확인하세요`)
    case 7:
      return failed(`서버에 연결하지 못함: ${at} — 포트, 방화벽, 사내망·VPN 연결을 확인하세요`)
    case 28:
      return failed(`${seconds}초 안에 응답이 없음: ${at} — 사내망·VPN 연결, 포트, 패시브 모드(고급 설정)를 확인하세요`)
    case 67:
      return failed('로그인 실패 — 저장한 사용자 이름과 비밀번호를 확인하세요')
    case 9:
      return failed(`로그인은 됐지만 운영 루트(${root}) 폴더에 들어가지 못함 — 운영 루트 경로를 확인하세요`)
    case 19:
    case 78:
      return failed(`로그인은 됐지만 운영 루트(${root})의 목록을 받지 못함 — 폴더가 비었거나 목록을 볼 권한이 없을 수 있음`)
    case 12:
    case 13:
    case 14:
    case 15:
    case 30:
      return failed('로그인은 됐지만 데이터 연결을 열지 못함 — 패시브 모드(고급 설정)를 바꿔 보세요')
    default:
      return failed(`접속 확인 실패: ${p.err || '알 수 없는 오류'}`)
  }
}
