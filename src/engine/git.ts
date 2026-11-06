// git·gh 호출. 저장소 경로는 Windows 형식(C:/...)을 받는다.
import { exec, Stop, toNative, type ExecResult } from './util.ts'

export function git(repo: string, args: string[], input?: string): Promise<ExecResult> {
  return exec('git', ['-C', toNative(repo), '-c', 'core.quotePath=false', ...args], { input })
}

export async function gitText(repo: string, args: string[]): Promise<string> {
  const r = await git(repo, args)
  if (r.code !== 0) throw new Stop(`git ${args.join(' ')} 실패: ${r.err.trim()}`)
  return r.out.toString('utf8').trim()
}

export async function gitOk(repo: string, args: string[]): Promise<boolean> {
  return (await git(repo, args)).code === 0
}

/** 커밋 이름 → 전체 해시. 없으면 null. */
export async function revParse(repo: string, rev: string): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  return r.code === 0 ? r.out.toString('utf8').trim() : null
}

/** `git show <rev>:<path>` 의 바이트. 없으면 null. */
export async function showFile(repo: string, rev: string, path: string): Promise<Buffer | null> {
  const r = await git(repo, ['show', `${rev}:${path}`])
  return r.code === 0 ? r.out : null
}

export type Change = { status: 'A' | 'M' | 'D'; path: string }

/** base..tip 사이에 바뀐 파일. 이름 바꾸기는 지우기+새 파일로 본다(bash 와 같다). */
export async function changedFiles(repo: string, base: string, tip: string): Promise<Change[]> {
  const r = await git(repo, ['diff', '--name-status', '--no-renames', '-z', base, tip])
  if (r.code !== 0) throw new Stop(`git diff 실패: ${r.err.trim()}`)
  const parts = r.out.toString('utf8').split('\0').filter((s) => s !== '')
  const list: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i][0]
    const status = s === 'A' ? 'A' : s === 'D' ? 'D' : 'M'
    list.push({ status, path: parts[i + 1] })
  }
  return list
}

/** 저장소의 공통 .git 폴더(워크트리여도 같은 값). */
export async function commonDir(dir: string): Promise<string | null> {
  const r = await exec('git', ['-C', toNative(dir), 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (r.code !== 0) return null
  return r.out.toString('utf8').trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
}

export type PullRequest = {
  number: number
  title: string
  url: string
  state: string
  mergeCommit: string | null
  body: string
}

export async function viewPr(repo: string, n: number): Promise<PullRequest> {
  const r = await exec('gh', ['pr', 'view', String(n), '--json', 'number,title,url,state,mergeCommit,body'], {
    cwd: toNative(repo)
  })
  if (r.code !== 0) throw new Stop(`PR #${n} 를 찾지 못함: ${r.err.trim()}`)
  const j = JSON.parse(r.out.toString('utf8'))
  return {
    number: j.number,
    title: j.title ?? '',
    url: j.url ?? '',
    state: j.state ?? '',
    mergeCommit: j.mergeCommit?.oid ?? null,
    body: j.body ?? ''
  }
}

/** PR 본문에서 "반영 시 주의" 절만 꺼낸다(제목 줄부터 같은 단계 이상의 다음 제목 전까지). */
export function deployNotes(body: string): string | null {
  const lines = body.replace(/\r/g, '').split('\n')
  const start = lines.findIndex((l) => /^#{1,6}\s.*반영\s*시\s*주의/.test(l))
  if (start < 0) return null
  const level = /^(#+)/.exec(lines[start])![1].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i])
    if (m && m[1].length <= level) {
      end = i
      break
    }
  }
  const text = lines.slice(start + 1, end).join('\n').trim()
  return text || null
}
