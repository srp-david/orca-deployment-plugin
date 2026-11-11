// 운영 반영 CLI. 스킬(Claude)과 패널의 워커가 같은 엔진을 이 명령으로 부른다.
//
// 사용법: node src/cli.ts <단계> ...
//   targets                                   대상 목록
//   check  [--target <대상>] <PR|커밋|기준..끝>   준비 확인만 (병합·main·pull·빌드·커밋 안 한 수정)
//   plan   [--target <대상>] <PR|커밋|기준..끝> [--backup]
//                                             읽기만. 준비 확인 → 반영 목록·운영 대조 → 확인 코드
//                                             --backup: 이어서 백업까지 (패널의 "반영 목록 만들기")
//   backup <run>                              읽기만. 덮어쓸 운영 파일을 run/backup/ 에 받고 plan 때와 대조
//   upload <run> --plan <코드> --yes           운영에 올리고 이어서 대조 (평소에는 패널 버튼으로. 패널을 못 쓸 때만)
//   verify <run>                              읽기만. 운영 파일이 올린 로컬 파일과 같은지 대조
//   rollback <run> --plan <코드> --yes         백업을 되올리고 새로 만든 파일은 지움
//   runs   [--target <대상>]                   지난 run 목록
//   show   <run>                              run 내용(반영 목록·문제·확인 코드)
//   unlock <대상>                             끝난 작업이 남긴 잠금 풀기(살아 있는 작업의 잠금은 안 풂)
//   creds  <대상> status|delete                FTP 접속 정보(자격 증명 관리자 prod-deploy:<대상>)
//   creds  <대상> set                          stdin 첫 줄 사용자, 둘째 줄 비밀번호
// 공통: --json (결과를 JSON 으로), --job <id> (워커가 띄운 작업 기록), --by <실행 주체>
//
// 원칙: upload·rollback 은 사람이 반영 목록·대상을 보고 승인한 확인 코드로만 실행된다.
//       --target 을 빼면 지금 폴더의 저장소로 대상을 찾는다(시험용 대상은 빼고, 못 찾으면 멈춤).
//       SQL·톰캣 재기동·메뉴 등록은 하지 않는다. 접속 정보는 출력하지 않는다.
import { credentialUser, deleteCredential, writeCredential } from './engine/creds.ts'
import { JobWriter, type JobStep } from './engine/jobs.ts'
import { plan, preflight } from './engine/plan.ts'
import { clearStaleLock, listRuns, openRun, STATUS_LABEL } from './engine/runs.ts'
import { backup, rollback, upload, verify } from './engine/steps.ts'
import { detectTarget, listTargets, loadTarget, loadTargetOrDeleted, type Target } from './engine/target.ts'
import { Stop } from './engine/util.ts'
import { renderRun, viewRun } from './engine/view.ts'

type Args = { positional: string[]; flags: Record<string, string | true> }

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '--json' || a === '--backup') flags[a.slice(2)] = true
    else if (a.startsWith('--')) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Stop(`${a} 에 값이 필요함`)
      flags[a.slice(2)] = v
      i++
    } else positional.push(a)
  }
  return { positional, flags }
}

const flag = (a: Args, k: string) => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : null)

function usage(): never {
  process.stdout.write(
    `사용법: node src/cli.ts <targets|check|plan|backup|upload|verify|rollback|runs|show|unlock|creds> ...\n` +
      `자세한 인자는 src/cli.ts 맨 위 설명을 보세요.\n`
  )
  process.exit(2)
}

async function pickTarget(a: Args): Promise<Target> {
  const id = flag(a, 'target')
  if (id) return loadTarget(id)
  const d = await detectTarget(process.cwd())
  if (d.target) return loadTarget(d.target)
  if (d.candidates.length > 1) throw new Stop(`이 저장소의 대상이 여럿 (${d.candidates.join(', ')}) — --target 을 주세요`)
  throw new Stop('대상을 정할 수 없음 — --target 을 주세요 (targets 로 목록 확인)')
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d: string) => (s += d))
    process.stdin.on('end', () => resolve(s))
  })
}

async function main(): Promise<number> {
  const [step, ...rest] = process.argv.slice(2)
  if (!step) usage()
  const a = parseArgs(rest)
  const json = a.flags.json === true
  const say = (s: string) => process.stdout.write(s + '\n')
  const by = flag(a, 'by') ?? 'cli'
  const jobId = flag(a, 'job')
  const job = (target: string, run: string | null, spec: string | null) =>
    new JobWriter(jobId, { step: step as JobStep, target, run, spec })

  switch (step) {
    case 'targets': {
      const ts = listTargets()
      if (json) say(JSON.stringify(ts))
      else for (const t of ts) say(`${t.id}\t${t.label}  (${t.repo} → ftp://${t.connection.host}${t.connection.root})${t.test ? '  [시험용]' : ''}`)
      return 0
    }

    case 'check': {
      const spec = a.positional[0] ?? usage()
      const t = await pickTarget(a)
      const pf = await preflight(t, spec)
      if (json) say(JSON.stringify(pf))
      else {
        say(`대상: ${t.label} → ftp://${t.connection.host}${t.connection.root}`)
        if (pf.resolved) say(`반영 커밋: ${pf.resolved.subject}`)
        for (const i of pf.items) {
          say(`${i.ok ? '✔' : '✘'} ${i.title}`)
          for (const d of i.detail) say(`    ${d}`)
          if (i.fix) say(`    할 일: ${i.fix}`)
        }
        if (pf.resolved?.pr?.notes) say(`\n== PR #${pf.resolved.pr.number} 반영 시 주의 ==\n${pf.resolved.pr.notes}`)
      }
      return pf.ok ? 0 : 1
    }

    case 'plan': {
      const spec = a.positional[0] ?? usage()
      const t = await pickTarget(a)
      const w = job(t.id, null, spec)
      try {
        const r = await plan(
          t,
          spec,
          (s) => {
            say(s)
            w.line(s)
          },
          (n, total) => w.progress(n, total),
          (id) => w.setRun(id)
        )
        if (!r.run) {
          const failed = r.preflight.items.filter((i) => !i.ok)
          for (const i of failed) {
            say(`✘ ${i.title}`)
            for (const d of i.detail) say(`    ${d}`)
            if (i.fix) say(`    할 일: ${i.fix}`)
          }
          const msg = `준비 확인 실패: ${failed.map((i) => i.title).join(', ')}`
          say(`멈춤: ${msg}`)
          w.finish(false, msg)
          return 1
        }
        const withBackup = a.flags.backup === true
        if (r.code && withBackup) {
          say('')
          await backup(r.run.id, {
            by,
            say: (s: string) => {
              say(s)
              w.line(s)
            },
            progress: (n: number, total: number) => w.progress(n, total)
          })
        }
        const v = viewRun(r.run)
        if (json) say(JSON.stringify(v))
        else say('\n' + renderRun(v))
        const done = withBackup ? '반영 목록·백업 완료' : 'plan 완료'
        w.finish(!!r.code, r.code ? `${done}: ${v.total}개, 확인 코드 ${r.code}` : v.errors.length ? `문제 ${v.errors.length}건` : '올릴 파일 없음')
        return r.code ? 0 : 1
      } catch (e) {
        w.finish(false, (e as Error).message)
        throw e
      }
    }

    case 'backup':
    case 'upload':
    case 'verify':
    case 'rollback': {
      const id = a.positional[0] ?? usage()
      const run = openRun(id)
      const w = job(run.target.id, id, null)
      const hooks = {
        by,
        say: (s: string) => {
          say(s)
          w.line(s)
        },
        progress: (n: number, total: number) => w.progress(n, total)
      }
      try {
        if (step === 'backup') await backup(id, hooks)
        else if (step === 'verify') await verify(id, hooks)
        else {
          const code = flag(a, 'plan') ?? ''
          const yes = a.flags.yes === true
          if (step === 'upload') {
            await upload(id, code, yes, hooks)
            // 올린 뒤 바로 대조한다(읽기만). 대조가 실패해도 업로드는 끝난 상태로 남는다.
            hooks.say('')
            await verify(id, hooks)
          } else await rollback(id, code, yes, hooks)
        }
        w.finish(true, null)
        return 0
      } catch (e) {
        w.finish(false, (e as Error).message)
        throw e
      }
    }

    case 'runs': {
      const t = await pickTarget(a)
      const runs = listRuns(t)
      if (json) say(JSON.stringify(runs.map(viewRun)))
      else for (const r of runs) say(`${r.id}\t${STATUS_LABEL[r.status()]}\t${r.plan().length}개`)
      return 0
    }

    case 'show': {
      const id = a.positional[0] ?? usage()
      const v = viewRun(openRun(id))
      say(json ? JSON.stringify(v) : renderRun(v))
      return 0
    }

    case 'unlock': {
      const id = a.positional[0] ?? usage()
      loadTargetOrDeleted(id)
      say(clearStaleLock(id))
      return 0
    }

    case 'creds': {
      const [id, op = 'status'] = a.positional
      if (!id) usage()
      loadTarget(id)
      if (op === 'status') {
        const u = await credentialUser(id)
        say(u ? `prod-deploy:${id} 있음 (사용자 ${u})` : `prod-deploy:${id} 없음`)
        return u ? 0 : 1
      }
      if (op === 'delete') {
        say((await deleteCredential(id)) ? '지움' : '없었음')
        return 0
      }
      if (op === 'set') {
        const [user = '', password = ''] = (await readStdin()).replace(/\r/g, '').split('\n')
        await writeCredential(id, { user: user.trim(), password })
        say(`prod-deploy:${id} 저장함 (사용자 ${user.trim()})`)
        return 0
      }
      usage()
    }
    // falls through
    default:
      usage()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof Stop) {
      if (!e.reported) process.stdout.write(`멈춤: ${e.message}\n`)
      process.exit(1)
    }
    process.stderr.write(String((e as Error).stack ?? e) + '\n')
    process.exit(1)
  }
)
