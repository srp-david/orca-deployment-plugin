# CLI 와 Claude Code 스킬

## CLI

패널과 같은 엔진을 명령으로 씁니다(패널의 워커도 운영 FTP 단계는 이 CLI 를 띄워 실행합니다 — [ADR 0002](adr/0002-ftp-steps-run-as-cli-process.md)). 평소에는 패널을 쓰고, **업로드·되돌리기는 패널을 못 쓸 때만** CLI 로 합니다.

```powershell
node src/cli.ts targets                                   # 대상 목록
node src/cli.ts check  --target myapp "#123"              # 준비 확인만
node src/cli.ts plan   --target myapp "#123" --backup     # 반영 목록 만들기(plan + 백업) → run 이름·확인 코드
node src/cli.ts backup <run>                              # 백업만 다시
node src/cli.ts upload <run> --plan <확인 코드> --yes      # 올리고 이어서 대조
node src/cli.ts verify <run>                              # 대조만 다시
node src/cli.ts rollback <run> --plan <확인 코드> --yes
node src/cli.ts runs   --target myapp                     # 지난 run
node src/cli.ts show   <run>                              # run 내용(반영 목록·문제·확인 코드)
node src/cli.ts unlock myapp                              # 끝난 작업이 남긴 잠금 풀기
node src/cli.ts creds  myapp status|set|delete            # 접속 정보
```

- 반영할 것: PR 번호(`#123`, `123`), 커밋 해시, 또는 `기준..끝` 구간.
- `--target` 을 빼면 지금 폴더의 저장소로 대상을 찾습니다(시험용 대상은 빼고, 못 찾으면 멈춤).
- 공통: `--json`(결과를 JSON 으로).
- `creds <대상> set` 은 stdin 첫 줄을 사용자, 둘째 줄을 비밀번호로 읽습니다. 아래처럼 쓰면 PowerShell 기록에 비밀번호가 남을 수 있으니 되도록 패널에서 넣으세요.

```powershell
"ftpuser`nftppassword" | node src/cli.ts creds myapp set
```

## Claude Code 스킬

`skill/prod-deploy/` 에 Claude Code 스킬(`SKILL.md`)과 확인 훅(`guard-hook.sh`)이 있습니다.

- Claude 는 준비 확인·반영 목록 만들기·대조를 CLI 로 하고, **업로드·되돌리기는 패널에서 사람이 누르도록 안내**합니다.
- 사람이 "패널을 못 쓴다"고 할 때만 반영 목록을 보여 주고 승인을 받은 뒤 CLI 로 올립니다. 그때도 훅이 확인 창을 한 번 더 띄웁니다.

설치:

```powershell
node skill/install.mjs   # ~/.claude/skills/prod-deploy/ 로 복사 (덮어쓰는 파일은 .backup-<시각>/ 에 남김)
```

`settings.json` 은 설치 스크립트가 고치지 않습니다. 직접 넣으세요.

```jsonc
{
  "permissions": {
    "ask": [
      "Bash(node *cli.ts upload *)", "Bash(node *cli.ts rollback *)",
      "Bash(node *cli.ts unlock *)", "Bash(node *cli.ts creds *)",
      "PowerShell(node *cli.ts upload *)", "PowerShell(node *cli.ts rollback *)",
      "PowerShell(node *cli.ts unlock *)", "PowerShell(node *cli.ts creds *)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [{ "type": "command", "command": "bash \"C:/Users/<사용자>/.claude/skills/prod-deploy/scripts/guard-hook.sh\"", "timeout": 10 }]
      }
    ]
  }
}
```

`permissions.ask` 는 명령 모양이 정확히 맞을 때만 걸리므로, 따옴표·`cd`·환경변수가 붙어도 잡히도록 훅을 함께 둡니다. 훅은 `cli.ts` 의 `upload`·`rollback`·`unlock`·`creds` 에서 확인 창을 띄웁니다(시험: `test/guard-hook.spec.ts`).
