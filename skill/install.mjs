// Claude Code 스킬 설치: node skill/install.mjs
// skill/prod-deploy/ 를 ~/.claude/skills/prod-deploy/ 로 복사한다.
//   - SKILL.md 의 {{REPO}} 를 이 저장소 경로로 바꾼다.
//   - guard-hook.sh 는 scripts/guard-hook.sh 로 둔다(settings.json 의 훅 경로).
//   - 덮어쓰는 파일은 .backup-<시각>/ 에 먼저 남긴다. 그 밖의 파일(예전 deploy.sh 등)은 건드리지 않는다.
// settings.json 은 고치지 않는다. 넣을 내용은 README 의 "Claude Code 스킬" 절을 보세요.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/')
const src = join(repo, 'skill', 'prod-deploy')
const dest = join(homedir(), '.claude', 'skills', 'prod-deploy')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')

const files = [
  { from: 'SKILL.md', to: 'SKILL.md', fill: true },
  { from: 'guard-hook.sh', to: join('scripts', 'guard-hook.sh'), fill: false }
]

for (const f of files) {
  const target = join(dest, f.to)
  if (existsSync(target)) {
    const backup = join(dest, `.backup-${stamp}`, f.to)
    mkdirSync(dirname(backup), { recursive: true })
    copyFileSync(target, backup)
    console.log(`백업: ${backup}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  const text = readFileSync(join(src, f.from), 'utf8')
  writeFileSync(target, f.fill ? text.split('{{REPO}}').join(repo) : text)
  console.log(`설치: ${target}`)
}
