// curl 로 FTP. 접속 정보는 curl 설정을 stdin(-K -)으로 넘겨 명령줄·프로세스 목록에 남지 않게 한다.
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readCredential } from './creds.ts'
import { netrcPath, type Target } from './target.ts'
import { exec, sha256, Stop, toNative } from './util.ts'

export type FtpAuth = { kind: 'user'; user: string; password: string } | { kind: 'netrc'; file: string }

/** 자격 증명 관리자 → 없으면 옮기는 동안의 netrc. 둘 다 없으면 멈춘다. */
export async function resolveAuth(t: Target): Promise<FtpAuth> {
  const c = await readCredential(t.id)
  if (c) return { kind: 'user', user: c.user, password: c.password }
  const netrc = netrcPath(t)
  if (netrc) {
    if (existsSync(toNative(netrc))) return { kind: 'netrc', file: toNative(netrc) }
    throw new Stop(`접속 정보 없음: 자격 증명 관리자에 prod-deploy:${t.id} 가 없고 ${netrc} 도 없음`)
  }
  throw new Stop(`접속 정보 없음: 자격 증명 관리자에 prod-deploy:${t.id} 가 없음 (패널의 대상 설정에서 넣기)`)
}

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** URL 경로: 조각마다 인코딩(공백·한글·# 등). `/` 는 그대로. */
function urlPath(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

/** 접속 확인에 쓰는 시간 제한(초). 패널 요청 하나가 이보다 오래 붙잡히지 않게 한다. */
export const PROBE_SECONDS = 20

/** 접속 확인 결과: 성공이면 그 폴더의 항목 수, 실패면 curl 종료 코드와 첫 줄. */
export type Probe = { ok: true; count: number } | { ok: false; code: number; err: string }

export class Ftp {
  readonly t: Target
  readonly auth: FtpAuth
  readonly log: (line: string) => void
  private lists = new Map<string, { ok: true; names: Set<string> } | { ok: false; code: number; err: string }>()

  constructor(t: Target, auth: FtpAuth, log: (line: string) => void = () => {}) {
    this.t = t
    this.auth = auth
    this.log = log
  }

  base(): string {
    const c = this.t.connection
    return `ftp://${c.host}${c.port && c.port !== 21 ? ':' + c.port : ''}`
  }

  url(remote: string): string {
    return this.base() + urlPath(remote)
  }

  private async curl(args: string[], seconds = 60): Promise<{ ok: boolean; code: number; out: Buffer; err: string }> {
    const common = ['-sS', '--max-time', String(seconds)]
    const verbose = !!process.env.PRODDEPLOY_CURL_VERBOSE
    if (verbose) common.push('-v')
    if (this.t.connection.passive === false) common.push('--ftp-port', '-')
    let input = ''
    if (this.auth.kind === 'user') {
      common.push('-K', '-')
      input = `user = ${quote(`${this.auth.user}:${this.auth.password}`)}\n`
    } else common.push('--netrc-file', this.auth.file)
    const r = await exec('curl', [...common, ...args], { input, timeoutMs: seconds * 2000 })
    if (r.code !== 0 && r.err.trim())
      this.log(`curl: ${verbose ? r.err.replace(/^> PASS .*$/gm, '> PASS ***') : r.err.trim()}`)
    return { ok: r.code === 0, code: r.code, out: r.out, err: r.err }
  }

  /** 폴더 목록 한 번: 성공이면 이름들, 실패면 curl 종료 코드. 같은 실행 안에서는 다시 묻지 않는다. */
  private async listing(dir: string): Promise<{ ok: true; names: Set<string> } | { ok: false; code: number; err: string }> {
    const key = dir.replace(/\/+$/, '') || '/'
    const hit = this.lists.get(key)
    if (hit) return hit
    const r = await this.curl([this.url(key === '/' ? '/' : key + '/'), '--list-only'])
    const res: { ok: true; names: Set<string> } | { ok: false; code: number; err: string } = r.ok
      ? {
          ok: true,
          names: new Set(
            r.out
              .toString('utf8')
              .split('\n')
              .map((x) => x.replace(/\r$/, ''))
              .filter((x) => x !== '')
              .map((x) => x.split('/').pop()!)
          )
        }
      : { ok: false, code: r.code, err: r.err.trim().split('\n')[0] }
    this.lists.set(key, res)
    return res
  }

  /**
   * 운영에 그 경로가 있는가. "없음"은 확실할 때만 답한다: 부모 폴더 목록을 받았는데 이름이 없거나, 부모 폴더 자체가
   * 그 위 폴더 목록에 없을 때. 목록 권한 거부(550)·시간 초과처럼 애매하면 멈춘다 — "없음"으로 잘못 보면 백업 없이
   * 덮어쓰거나 되돌리기에서 새 파일을 지우지 않고 지나가게 된다.
   */
  async exists(remote: string): Promise<boolean> {
    const path = remote.replace(/\/+$/, '')
    if (path === '') return true
    const i = path.lastIndexOf('/')
    const dir = path.slice(0, i) || '/'
    const name = path.slice(i + 1)
    const l = await this.listing(dir)
    if (l.ok) return l.names.has(name)
    // 폴더에 들어가지 못함(9): 폴더가 정말 없는지 위 폴더에서 확인한다.
    if (l.code === 9 && dir !== '/' && !(await this.exists(dir))) return false
    // 목록이 550(19·78)인데 파일을 직접 받을 수 있으면 있는 것.
    if ((l.code === 19 || l.code === 78) && (await this.read(path)) !== null) return true
    throw new Stop(`운영 폴더 목록을 확인할 수 없음: ${dir} (curl ${l.code}: ${l.err}) — 있는지 없는지 모르면 진행하지 않음`)
  }

  /**
   * 접속 확인: 로그인해서 폴더 하나의 목록을 받아 본다(읽기만). 폴더 내용은 돌려주지 않고 개수만 준다.
   * exists('/') 는 접속하지 않고 true 를 주므로 접속 확인에 쓰면 안 된다. 결과는 기억하지 않는다(누를 때마다 새로 접속).
   */
  async probe(dir: string, seconds = PROBE_SECONDS): Promise<Probe> {
    const key = dir.replace(/\/+$/, '')
    const r = await this.curl([this.url(key + '/'), '--list-only', '--connect-timeout', String(Math.min(10, seconds))], seconds)
    if (!r.ok) {
      // 화면에 보일 말이다: curl 이 낸 오류 줄(`curl: (67) …`)만 넘긴다. 다른 진단 출력(자세히 보기 모드 등)은 넘기지 않는다.
      const line = r.err.split('\n').find((x) => /^curl: \(\d+\) /.test(x.trim()))
      // -1 은 curl 을 띄우지 못했거나(spawn 오류) 시간 안에 끝나지 않아 멈춘 경우다.
      const spawnError = r.code === -1 && /^spawn /.test(r.err) ? r.err.trim().split('\n')[0] : ''
      return { ok: false, code: r.code, err: (line ?? spawnError).trim() }
    }
    const names = r.out
      .toString('utf8')
      .split('\n')
      .map((x) => x.replace(/\r$/, ''))
      .filter((x) => x !== '' && x !== '.' && x !== '..')
    return { ok: true, count: names.length }
  }

  /** 운영 파일 → 로컬 파일. 실패하면 false. */
  async get(remote: string, dest: string): Promise<boolean> {
    mkdirSync(dirname(toNative(dest)), { recursive: true })
    return (await this.curl([this.url(remote), '-o', toNative(dest)])).ok
  }

  async read(remote: string): Promise<Buffer | null> {
    const r = await this.curl([this.url(remote)])
    return r.ok ? r.out : null
  }

  /** 쓰고 나면 목록 기억을 모두 버린다(폴더가 새로 생겼을 수 있다). */
  private forget(_remote: string): void {
    this.lists.clear()
  }

  /** 임시 이름(.uploading)으로 올린 뒤 같은 폴더에서 이름 바꾸기. 폴더가 없으면 만든다. */
  async put(src: string, remote: string): Promise<boolean> {
    this.forget(remote)
    const tmp = `${remote}.uploading`
    const r = await this.curl([
      '--ftp-create-dirs',
      '-T',
      toNative(src),
      this.url(tmp),
      '-Q',
      `-RNFR ${tmp}`,
      '-Q',
      `-RNTO ${remote}`
    ])
    if (r.ok) return true
    await this.curl([this.url(remote.slice(0, remote.lastIndexOf('/')) + '/'), '--list-only', '-Q', `DELE ${tmp}`])
    return false
  }

  async delete(remote: string): Promise<boolean> {
    this.forget(remote)
    const r = await this.curl([this.url(remote.slice(0, remote.lastIndexOf('/')) + '/'), '--list-only', '-Q', `DELE ${remote}`])
    return r.ok
  }

  /** 운영 파일의 sha256. 받지 못하면 null. */
  async shaOf(remote: string): Promise<string | null> {
    const got = await this.read(remote)
    return got === null ? null : sha256(got)
  }
}
