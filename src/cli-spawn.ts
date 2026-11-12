// 워커가 CLI 프로세스(node src/cli.ts ...)를 띄우지 못했을 때 사람에게 보여 줄 말.

/**
 * `spawn node ENOENT` 는 node 를 못 찾았을 때도, 실행할 폴더(cwd)를 열 수 없을 때도 똑같이 나온다.
 * 폴더는 띄우기 전에 따로 확인하지만(그 뒤 사라지거나 권한이 없을 수 있다), 어느 쪽인지 단정하지 않고 둘 다 알려 준다.
 */
export function cliSpawnError(e: { code?: string; message: string }, cwd: string): string {
  if (e.code === 'ENOENT')
    return (
      `CLI 를 띄우지 못함(${e.message}): Windows 에서 node 를 찾지 못했거나 메인 체크아웃 폴더(${cwd})를 열 수 없음 — ` +
      'Windows 용 Node.js(24 권장)를 설치하고 Orca 를 완전히 껐다 켜세요. WSL 안에 설치한 Node 는 쓰지 못합니다.'
    )
  return `CLI 를 띄우지 못함: ${e.message}`
}
