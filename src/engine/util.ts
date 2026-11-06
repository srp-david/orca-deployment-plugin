// 엔진 공통: 경로, 하위 프로세스, sha256, 시각. 워커(Orca 내장 Node)와 CLI(시스템 node)가 같이 쓴다.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 대상 설정·시험 run·잠금·작업 기록이 사는 곳. 시험에서는 PRODDEPLOY_HOME 으로 바꾼다. */
export function home(): string {
  return process.env.PRODDEPLOY_HOME || join(homedir(), '.prod-deploy')
}

/** `~/x` → 홈 기준 절대경로. 슬래시는 `/` 로 맞춘다. */
export function expandHome(p: string): string {
  const s = p.replace(/\\/g, '/')
  if (s === '~') return homedir().replace(/\\/g, '/')
  if (s.startsWith('~/')) return homedir().replace(/\\/g, '/') + s.slice(1)
  return s
}

/** `/c/work/x` → `C:/work/x` (bash 시절 run 기록의 경로를 Node 가 열 수 있게). */
export function toNative(p: string): string {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : p
}

/** `C:/work/x` 또는 `C:\work\x` → `/c/work/x` (plan.tsv 는 bash 와 같은 형식으로 쓴다). */
export function toMsys(p: string): string {
  const s = p.replace(/\\/g, '/')
  const m = /^([a-zA-Z]):(\/.*)?$/.exec(s)
  return m ? `/${m[1].toLowerCase()}${m[2] ?? ''}` : s
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function shaFile(path: string): string {
  return sha256(readFileSync(toNative(path)))
}

/** CR 을 뺀 내용이 같은가(운영본 대조는 개행 차이를 무시한다). */
export function sameIgnoringCR(a: Uint8Array, b: Uint8Array): boolean {
  const strip = (x: Uint8Array) => Buffer.from(x).toString('latin1').replace(/\r/g, '')
  return strip(a) === strip(b)
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `20261106-180012` */
export function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** `18:00:12` */
export function clock(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `2026-11-06 18:00:12` */
export function dateTime(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)}`
}

export type ExecResult = { code: number; out: Buffer; err: string }
export type ExecOptions = {
  cwd?: string
  input?: string | Uint8Array
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

/** 하위 프로세스를 셸 없이 실행한다. 실패해도 throw 하지 않고 code 로 돌려준다. */
export function exec(cmd: string, args: string[], o: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: o.cwd,
        env: o.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (e) {
      resolve({ code: -1, out: Buffer.alloc(0), err: String((e as Error).message) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    const timer = o.timeoutMs ? setTimeout(() => child.kill(), o.timeoutMs) : undefined
    child.on('error', (e: Error) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, out: Buffer.concat(out), err: e.message })
    })
    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.on('error', () => {})
    if (o.input !== undefined) child.stdin.end(o.input)
    else child.stdin.end()
  })
}

/** 엔진이 멈출 때 쓰는 오류. message 는 사람에게 그대로 보여 준다. */
export class Stop extends Error {
  /** 이미 로그·화면에 "멈춤:" 으로 알린 경우. */
  reported = false
  constructor(message: string) {
    super(message)
    this.name = 'Stop'
  }
}
