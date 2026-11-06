// 작업 기록: 워커가 띄운 CLI 프로세스의 진행 상황. ~/.prod-deploy/jobs/<id>.json
// 워커가 다시 시작되거나 패널이 닫혀도 CLI 는 끝까지 가고, 다시 열면 이 파일에서 이어 본다.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './util.ts'

export type JobStep = 'check' | 'plan' | 'backup' | 'upload' | 'verify' | 'rollback'
export type JobState = 'starting' | 'running' | 'done' | 'failed'
export type Job = {
  id: string
  step: JobStep
  target: string
  run: string | null
  spec: string | null
  state: JobState
  message: string | null
  progress: { n: number; total: number } | null
  lines: string[]
  startedAt: number
  endedAt: number | null
  pid: number | null
  /** 파일만 보고 "프로세스가 끝남"으로 추정한 실패(저장하지 않는 표시). */
  inferred?: boolean
}

const MAX_LINES = 300

export function jobsDir(): string {
  return join(home(), 'jobs')
}

export function newJobId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * 작업 기록을 쓴다. Windows 에서는 다른 프로세스(워커)가 읽는 순간 이름 바꾸기가 실패하므로 몇 번 다시 시도한다.
 * 성공하면 true. 실패해도 throw 하지 않는다 — 기록은 보조 정보라, 쓰기 실패가 업로드를 멈추게 하면 안 된다.
 */
export function writeJob(job: Job, tries = 10): boolean {
  try {
    mkdirSync(jobsDir(), { recursive: true })
    const f = join(jobsDir(), `${job.id}.json`)
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...job, lines: job.lines.slice(-MAX_LINES) }), 'utf8')
    for (let i = 0; i < tries; i++) {
      try {
        renameSync(tmp, f)
        return true
      } catch {
        pause(30 + i * 20)
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // 무시
    }
    return false
  } catch {
    return false
  }
}

function alive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM'
  }
}

export function readJob(id: string): Job | null {
  if (!/^[a-z0-9]+$/.test(id)) return null
  const f = join(jobsDir(), `${id}.json`)
  if (!existsSync(f)) return null
  try {
    // 이름 바꾸기 순간과 겹치면 잠깐 못 읽을 수 있다: 두어 번 다시 읽는다.
    let text = ''
    for (let i = 0; i < 3; i++) {
      try {
        text = readFileSync(f, 'utf8')
        break
      } catch {
        pause(20)
      }
    }
    const j = JSON.parse(text) as Job
    // 시작한 지 30초가 지났는데 프로세스가 없으면 끝난 것으로 본다(갑자기 죽은 경우).
    if ((j.state === 'running' || j.state === 'starting') && !alive(j.pid) && Date.now() - j.startedAt > 30000) {
      j.state = 'failed'
      j.inferred = true
      j.message = j.message ?? '작업 프로세스가 결과를 남기지 않고 끝남 — 로그를 보세요'
    }
    return j
  } catch {
    return null
  }
}

/** 최근 작업들(최근 것부터). 하루 지난 끝난 작업은 지운다. */
export function listJobs(): Job[] {
  if (!existsSync(jobsDir())) return []
  const out: Job[] = []
  for (const f of readdirSync(jobsDir())) {
    if (!f.endsWith('.json')) continue
    const j = readJob(f.slice(0, -5))
    if (!j) continue
    if (j.endedAt && Date.now() - j.endedAt > 86400000) {
      try {
        unlinkSync(join(jobsDir(), f))
      } catch {
        // 무시
      }
      continue
    }
    out.push(j)
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/** CLI 쪽: 작업 기록을 고쳐 가며 쓴다. id 가 없으면 아무것도 안 한다. */
export class JobWriter {
  job: Job | null
  private last = 0

  constructor(id: string | null, init: Omit<Job, 'id' | 'state' | 'message' | 'progress' | 'lines' | 'startedAt' | 'endedAt' | 'pid'>) {
    if (!id) {
      this.job = null
      return
    }
    const prev = readJob(id)
    this.job = {
      id,
      ...init,
      state: 'running',
      message: null,
      progress: null,
      lines: prev?.lines ?? [],
      startedAt: prev?.startedAt ?? Date.now(),
      endedAt: null,
      pid: process.pid
    }
    writeJob(this.job)
  }

  line(s: string): void {
    if (!this.job) return
    this.job.lines.push(s)
    this.flush()
  }

  progress(n: number, total: number): void {
    if (!this.job) return
    this.job.progress = { n, total }
    this.flush(n === total)
  }

  setRun(run: string): void {
    if (!this.job) return
    this.job.run = run
    this.flush(true)
  }

  /** 마지막 상태는 화면이 결과를 알 유일한 길이라 더 끈질기게 다시 쓴다(최대 3번 × 이름 바꾸기 20번 시도, 합쳐 약 15초). */
  finish(ok: boolean, message: string | null): void {
    if (!this.job) return
    this.job.state = ok ? 'done' : 'failed'
    this.job.message = message
    this.job.endedAt = Date.now()
    for (let i = 0; i < 3 && !writeJob(this.job, 20); i++) pause(200)
  }

  private flush(force = false): void {
    if (!this.job) return
    const now = Date.now()
    if (!force && now - this.last < 300) return
    // 못 쓰면 다음 줄에서 다시 쓴다(last 를 그대로 두어 바로 다시 시도).
    if (writeJob(this.job, force ? 10 : 3)) this.last = now
  }
}
