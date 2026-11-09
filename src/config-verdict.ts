// "설정 확인" 판정: 확인용 커밋(이미 반영된 커밋)으로 만든 run 을 보고 대상 설정이 맞는지 정한다.
// 패널과 워커(상태 표시줄·알림)가 같이 쓴다. Node API 를 쓰지 않는다(패널에서도 불러옴).
import type { RunView } from './protocol.ts'

export type ConfigVerdict = { ok: boolean; lines: string[] }

/** 모든 파일이 "이미 반영됨"이어야 하고(뒤에 다시 바뀐 파일은 빼고 봄), 운영에 없는 경로(새 파일)가 없어야 한다. */
export function configVerdict(v: Pick<RunView, 'errors' | 'rows'>): ConfigVerdict {
  const done = v.errors.filter((x) => /이미 반영됨/.test(x)).length
  const other = v.errors.filter((x) => !/이미 반영됨|main 에 이후 변경/.test(x))
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
