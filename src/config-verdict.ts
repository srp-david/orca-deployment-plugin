// "설정 확인" 판정: 확인용 커밋(이미 반영된 커밋)으로 만든 run 을 보고 대상 설정이 맞는지 정한다.
// 패널과 워커(상태 표시줄·알림)가 같이 쓴다. Node API 를 쓰지 않는다(패널에서도 불러옴).
import type { RunView } from './protocol.ts'

export type ConfigVerdict = { ok: boolean; lines: string[] }

/** 모든 파일이 "이미 반영됨"이어야 하고(뒤에 다시 바뀐 파일은 빼고 봄), 운영에 없는 경로(새 파일)가 없어야 한다. */
export function configVerdict(v: Pick<RunView, 'errors' | 'rows'>): ConfigVerdict {
  // 문장 앞머리로만 가른다: 다른 문제 문장 안(예: 상수 값)에 같은 낱말이 들어 있어도 섞이지 않게.
  const isDone = (x: string) => x.startsWith('운영본이 이미 반영 커밋 내용과 같음')
  const done = v.errors.filter(isDone).length
  const other = v.errors.filter((x) => !isDone(x) && !x.startsWith('main 에 이후 변경'))
  const fresh = v.rows.filter((r) => r.kind === 'A')
  const ok = done > 0 && other.length === 0 && fresh.length === 0
  const lines = [
    ok ? `맞음: ${done}개 파일이 운영에 이미 반영돼 있음` : '설정을 다시 보세요',
    ...other.map((x) => `· ${x}`),
    ...fresh.map((r) => `· 운영에 없는 경로(매핑 확인): ${r.remote}`)
  ]
  if (!done && !other.length && !fresh.length) lines.push('· 이미 반영된 파일을 하나도 찾지 못함')
  return { ok, lines }
}
