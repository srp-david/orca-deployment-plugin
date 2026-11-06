// 시험 FTP 루트를 "반영 직전 운영"처럼 채운다: 반영 커밋에서 바뀐 파일마다 직전 커밋의 내용을 운영 경로에 둔다.
// class 는 지금 빌드 결과를 둔다(운영본 대조를 하지 않으므로). 손 처리·매핑 밖 파일은 두지 않는다.
//
// 사용법: node test/seed-test-ftp.ts <커밋> [대상=test] [FTP 루트=~/.prod-deploy/test-ftp/root]
// 그다음: ~/.prod-deploy/test-ftp/venv/Scripts/python.exe -I test/ftp-server.py <FTP 루트> 2121
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { changedFiles, revParse, showFile } from '../src/engine/git.ts'
import { classFilesOf } from '../src/engine/plan.ts'
import { cleanLocal, loadTarget, manualReason, remotePathOf } from '../src/engine/target.ts'

const [rev, targetId = 'test', rootArg] = process.argv.slice(2)
if (!rev) {
  console.log('사용법: node test/seed-test-ftp.ts <커밋> [대상=test] [FTP 루트]')
  process.exit(2)
}
const t = loadTarget(targetId)
if (!t.test) throw new Error(`${targetId} 는 시험용 대상이 아님 — 운영 대상의 FTP 루트를 채우지 않는다`)
const ftpRoot = rootArg ?? join(homedir(), '.prod-deploy', 'test-ftp', 'root')
const tip = await revParse(t.repo, rev)
const base = tip && (await revParse(t.repo, `${tip}^`))
if (!tip || !base) throw new Error(`커밋 없음: ${rev}`)

rmSync(ftpRoot, { recursive: true, force: true })
const put = (remote: string, data: Uint8Array | string) => {
  const f = join(ftpRoot, remote)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, data)
}
let n = 0
for (const ch of await changedFiles(t.repo, base, tip)) {
  if (manualReason(t, ch.path)) continue
  if (t.java && ch.path.startsWith(cleanLocal(t.java.source) + '/') && ch.path.endsWith('.java')) {
    if (!existsSync(join(t.repo, ch.path))) continue
    for (const c of classFilesOf(t, ch.path).files.filter((x) => x.outer)) {
      const remote = remotePathOf(t, c.rel)
      if (!remote) continue
      mkdirSync(dirname(join(ftpRoot, remote)), { recursive: true })
      copyFileSync(c.abs, join(ftpRoot, remote))
      n++
    }
    continue
  }
  const remote = remotePathOf(t, ch.path)
  if (!remote) continue
  const before = await showFile(t.repo, base, ch.path)
  if (before) {
    put(remote, before)
    n++
  }
}
mkdirSync(join(ftpRoot, t.connection.root), { recursive: true })
console.log(`시험 FTP 루트 ${ftpRoot}: 직전 커밋 ${base.slice(0, 8)} 상태로 ${n}개`)
