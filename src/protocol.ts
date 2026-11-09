// 패널 ↔ 워커 약속. src/panel.tsx 와 src/worker.ts 가 같이 읽는다.
import type { Job, JobStep } from './engine/jobs.ts'
import type { CheckItem, PrInfo } from './engine/plan.ts'
import type { Target } from './engine/target.ts'
import type { RunView } from './engine/view.ts'

export type { CheckItem, Job, JobStep, PrInfo, RunView, Target }

export type TargetSummary = {
  id: string
  label: string
  host: string
  port: number
  root: string
  repo: string
  test: boolean
}

export type Workspace = {
  /** 작업공간 저장소로 고른 대상. 못 고르면 null. */
  target: string | null
  /** 이 저장소를 쓰는 (시험용 아닌) 대상들. */
  candidates: string[]
  /** 작업공간 경로를 알아냈는가. false 면 "작업공간 저장소를 알 수 없음". */
  known: boolean
  name: string | null
  path: string | null
}

export type PreflightView = {
  ok: boolean
  items: CheckItem[]
  subject: string | null
  tip: string | null
  pr: PrInfo | null
}

export type RunSummary = {
  id: string
  status: RunView['status']
  statusLabel: string
  verifyFailed: boolean
  total: number
  uploaded: number
  createdAt: number
  subject: string
}

/** 최근 병합된 PR 과, 이 대상에서 그 PR 로 만든 run 중 가장 앞선 상태. */
export type RecentPr = {
  number: number
  title: string
  mergedAt: string
  /** 'deployed' 업로드됨(대조 포함), 'partial' 부분 업로드, 'planned' 목록·백업까지, null 이 패널로 만든 run 없음. */
  deploy: 'deployed' | 'partial' | 'planned' | null
}

export type TargetDetail = {
  target: Target
  /** 자격 증명 관리자에 있는 사용자 이름. 없으면 null. */
  credUser: string | null
  /** 옮기는 동안의 netrc 가 있는가(내용은 읽지 않음). */
  netrc: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'targets.list': { output: TargetSummary[] }
    'target.get': { input: { id: string }; output: TargetDetail }
    /** 검사를 통과하면 저장. 잘못이 있으면 그 목록을 돌려준다. */
    'target.save': { input: { target: Target; previousId: string | null }; output: { errors: string[] } }
    'target.delete': { input: { id: string }; output: null }
    'target.validate': { input: { target: Target }; output: { errors: string[] } }
    'creds.set': { input: { id: string; user: string; password: string }; output: { user: string } }
    'creds.delete': { input: { id: string }; output: null }
    'workspace.detect': { output: Workspace }
    'check': { input: { target: string; spec: string }; output: PreflightView }
    'job.start': {
      /** plan 에 backup: true 면 이어서 백업까지(반영 목록 만들기). */
      input: { step: JobStep; target: string; spec?: string; run?: string; code?: string; backup?: boolean }
      output: { jobId: string }
    }
    /** 대상 저장소 main 에 최근 병합된 PR. */
    'prs.recent': { input: { target: string }; output: RecentPr[] }
    'job.get': { input: { id: string }; output: Job | null }
    'jobs.recent': { output: Job[] }
    'runs.list': { input: { target: string }; output: RunSummary[] }
    'run.get': { input: { id: string }; output: { view: RunView; log: string[] } }
    /** 끝난 작업이 남긴 잠금을 푼다. 살아 있는 작업의 잠금이면 거절. */
    'lock.clear': { input: { target: string }; output: { message: string } }
    /** 패널이 지금 사람에게 보이는지. 상태 표시줄을 누를 때 열지·닫을지 정하는 데 쓴다. */
    'panel.visible': { input: { visible: boolean }; output: { ok: true } }
    /** 상태 표시줄을 처음 모양(운영 반영)으로. 도는 작업이 있으면 그대로 둔다. */
    'status.reset': { output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** 워커가 띄운 작업의 진행이 바뀜. */
    'job.changed': Job
  }
}
