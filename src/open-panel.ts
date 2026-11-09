// 상태 표시줄의 "운영 반영"을 누르면 이 플러그인의 패널을 오른쪽 사이드바에 연다.
// Orca 플러그인 API 에는 워커가 패널을 여는 방법이 없어서(1.4.253 기준) Orca CLI 의
// `orca plugin open <플러그인 키> --panel <id>` 를 부른다. 플러그인 키는 설치 방식에 따라
// 다르므로(개발 폴더 local.prod-deploy, Git URL 설치 <소유자>.prod-deploy) 목록에서 찾는다.
import { dirname, join } from 'node:path'
import { exec, type ExecResult } from './engine/util.ts'

export const PANEL_ID = 'deploy'
type Run = (cmd: string, args: string[]) => Promise<ExecResult>

/** Orca CLI 후보: PATH 의 것, 기본 설치 위치, 워커를 띄운 Orca 옆. */
export function orcaCliCandidates(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform = process.platform): string[] {
  if (platform !== 'win32') return ['orca']
  const list = ['orca.exe']
  if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'))
  list.push(join(dirname(execPath), 'resources', 'bin', 'orca.exe'))
  return [...new Set(list)]
}

type ListedPlugin = { pluginKey?: string; status?: string; isDev?: boolean; panels?: { id?: string }[] }

/** `orca plugin list --json` 에서 이 플러그인의 키. 개발 폴더와 설치본이 함께 돌면 개발 폴더 쪽. */
export function pickPluginKey(listJson: string, panel = PANEL_ID): string | null {
  let plugins: ListedPlugin[]
  try {
    plugins = (JSON.parse(listJson) as { result?: { plugins?: ListedPlugin[] } }).result?.plugins ?? []
  } catch {
    return null
  }
  const mine = plugins
    .filter((p) => typeof p.pluginKey === 'string' && /^[\w-]+\.prod-deploy$/.test(p.pluginKey))
    .filter((p) => p.status === 'running' && (p.panels ?? []).some((x) => x.id === panel))
    .sort((a, b) => Number(!!b.isDev) - Number(!!a.isDev))
  return mine[0]?.pluginKey ?? null
}

/** 패널을 연다. 실패하면 이유를 돌려준다(성공하면 null). */
export async function openPanel(run: Run = (c, a) => exec(c, a, { timeoutMs: 15000 }), candidates = orcaCliCandidates()): Promise<string | null> {
  let lastError = 'Orca CLI(orca.exe)를 찾지 못함'
  for (const cli of candidates) {
    const list = await run(cli, ['plugin', 'list', '--json'])
    if (list.code === -1) continue // 이 위치에 없음
    if (list.code !== 0) {
      lastError = `플러그인 목록을 받지 못함: ${list.err.trim().split('\n')[0] ?? ''}`
      continue
    }
    const key = pickPluginKey(list.out.toString('utf8'))
    if (!key) return '플러그인 목록에서 운영 반영 플러그인을 찾지 못함'
    const r = await run(cli, ['plugin', 'open', key, '--panel', PANEL_ID])
    return r.code === 0 ? null : `패널을 열지 못함: ${r.err.trim().split('\n')[0] ?? `종료 코드 ${r.code}`}`
  }
  return lastError
}
