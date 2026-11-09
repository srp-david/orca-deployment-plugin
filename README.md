# 운영 반영 — Orca 플러그인 (`prod-deploy`)

저장소에서 바뀐 파일을 운영 서버에 **FTP로 반영**하는 Orca 오른쪽 사이드바 패널입니다. IntelliJ의 FTP Deployment처럼 대상(서버)마다 경로 매핑을 두고, PR 하나 또는 커밋 하나를 단위로 다음 순서로 진행합니다.

```
대상 → PR 고르기 → [반영 목록 만들기] 준비 확인 → plan → 백업 → 반영 목록 확인 → [업로드] 재대조 → 업로드 → 대조
                                                                          └ 문제가 생기면 → 되돌리기
```

압축 푼 WAR에 바뀐 파일만 올리는 Java 웹 애플리케이션 운영을 기준으로 만들었습니다. **이 도구는 파일만 다룹니다.** SQL 마이그레이션, 톰캣 재기동, 메뉴 등록, 재로그인 확인은 사람이 합니다.

용어는 [GLOSSARY.md](GLOSSARY.md), 구조를 정한 이유는 [docs/adr/](docs/adr/)에 있습니다.

---

## 목차

1. [요구 사항](#1-요구-사항)
2. [설치](#2-설치)
3. [처음 설정: 대상 만들기](#3-처음-설정-대상-만들기)
4. [반영하기](#4-반영하기)
5. [되돌리기](#5-되돌리기)
6. [안전장치](#6-안전장치)
7. [CLI (Claude 스킬·비상용)](#7-cli-claude-스킬비상용)
8. [데이터 위치와 run 기록](#8-데이터-위치와-run-기록)
9. [제한과 주의](#9-제한과-주의)
10. [문제 해결](#10-문제-해결)
11. [개발](#11-개발)

---

## 1. 요구 사항

| 항목 | 내용 |
|---|---|
| OS | **Windows 10/11**. 접속 정보를 Windows 자격 증명 관리자에 두기 때문에 지금은 Windows 전용입니다. |
| Orca | 1.4.248 이상 |
| Node.js | **24 권장**(22.18 이상). `node` 가 PATH 에 있어야 합니다. TypeScript 를 빌드 없이 바로 실행합니다. |
| git | PATH 에 있어야 합니다. |
| curl | Windows 기본 `curl.exe` 로 충분합니다. |
| GitHub CLI (`gh`) | PR 번호로 반영할 때 씁니다. `gh auth login` 으로 로그인돼 있어야 합니다. 커밋 해시로만 반영하면 없어도 됩니다. |
| PowerShell | Windows 기본 PowerShell 5.1 (자격 증명 관리자 접근에 씀) |

확인:

```powershell
node --version    # v24.x
git --version
curl --version
gh auth status
```

## 2. 설치

### A. 저장소를 받아 개발 폴더로 불러오기 (확실한 방법)

```powershell
git clone https://github.com/srp-david/orca-deployment-plugin.git C:\work\tools\orca-deployment-plugin
cd C:\work\tools\orca-deployment-plugin
orca plugin dev load .
```

처음에는 승인이 필요하다며 허용할 권한과 **fingerprint** 를 보여 줍니다. 내용을 확인한 뒤 직접 승인합니다.

```powershell
orca plugin dev load . --approve <출력된 fingerprint>
```

승인하면 오른쪽 사이드바에 로켓 아이콘 **운영 반영** 패널이 생깁니다. 이 플러그인이 요청하는 권한은 다음과 같습니다.

- 별도 Node 프로세스로 자기 코드 실행(사용자 계정 권한 — git·curl·PowerShell 을 실행합니다)
- 플러그인 자체 저장소 사용
- 지금 작업공간의 이름·브랜치 읽기(대상 자동 선택용)
- 데스크톱 알림

업데이트는 `git pull` 하면 Orca 가 자동으로 다시 불러옵니다(권한이 늘지 않으면 다시 승인하지 않아도 됩니다).

### B. Orca 에서 Git URL 로 설치

Orca 는 Git URL 로 플러그인을 설치할 수 있고, 이때 플러그인 이름은 `srp-david.prod-deploy` 가 됩니다. 설치할 때 위와 같은 권한 승인 화면이 나옵니다. (Orca 버전에 따라 메뉴 위치가 다를 수 있습니다. 안 되면 A 방법을 쓰세요.)

## 3. 처음 설정: 대상 만들기

**대상**은 "반영할 곳 하나"입니다: 저장소 하나 + FTP 주소 + 운영 루트. 같은 저장소에 운영·시험 대상을 여러 개 둘 수 있습니다.

대상 설정은 각자 PC 의 `~/.prod-deploy/targets/<대상 이름>.json` 에 저장됩니다(저장소에는 올라가지 않습니다).

### 3-1. 패널에서 만들기

패널 → **대상 설정** 탭 → **새 대상** → 칸을 채우고 **설정 저장**.

또는 예시 파일을 복사해서 고칩니다.

```powershell
mkdir $HOME\.prod-deploy\targets -Force
copy examples\java-war.json $HOME\.prod-deploy\targets\myapp.json
notepad $HOME\.prod-deploy\targets\myapp.json   # id 는 파일 이름과 같아야 함
```

### 3-2. 설정 항목

| 항목 | 설명 | 예 |
|---|---|---|
| `id` | 대상 이름. 영문 소문자·숫자·`_` 만. **만든 뒤에는 바꿀 수 없습니다**(run 기록이 이름에 묶임). | `myapp` |
| `label` | 화면에 보이는 이름. 업로드 버튼에도 들어갑니다. | `My App (운영)` |
| `test` | 시험용 대상이면 `true`. 자동으로 선택되지 않습니다. | |
| `repo` | **메인 체크아웃**: main 을 받아 두고 빌드하는 작업 폴더. 반영할 파일을 여기서 가져옵니다. | `C:/work/repos/my-app` |
| `mainBranch` | 기본 `main` | |
| `runs` | run 기록 폴더. 저장소 안이면 git 에서 빼 두세요(예: `.local/`). | `C:/work/repos/my-app/.local/deploy` |
| `connection.host` / `port` / `passive` | FTP 주소, 포트(기본 21), 패시브 모드(기본 켬) | `ftp.example.com` |
| `connection.root` | **운영 루트**: FTP 서버에서 압축 푼 WAR 의 맨 위 폴더 | `/webapps/ROOT` |
| `mappings` | **경로 매핑** 목록(아래) | |
| `java` | **Java 빌드 출력**(아래). Java 가 없으면 빼도 됩니다. | |
| `manual` | **손 처리 규칙** 목록(아래) | |
| `checkCommit` | **확인용 커밋**: 이미 운영에 반영된 것이 확실한 커밋. "설정 확인"에 씁니다. | |

#### 경로 매핑

저장소의 폴더 하나를 운영 루트 아래 폴더 하나에 잇습니다. 바뀐 파일이 여러 매핑에 걸리면 **로컬 경로가 가장 긴(가장 구체적인) 매핑**을 씁니다. 매핑은 폴더 단위이고 `*` 같은 패턴은 쓰지 않습니다.

```json
"mappings": [
  { "local": "src/main/webapp",          "remote": "/" },
  { "local": "build/classes/java/main",  "remote": "/WEB-INF/classes" }
]
```

`src/main/webapp/ui/a.xml` → `/webapps/ROOT/ui/a.xml`

#### Java 빌드 출력

git diff 에는 `.java` 만 나오므로, 바뀐 `.java` 를 빌드 결과 `.class` 로 바꿔 올립니다(IntelliJ 모듈의 Compiler output 과 같은 개념). 빌드 결과 폴더도 경로 매핑에 있어야 합니다.

```json
"java": { "source": "src/main/java", "output": "build/classes/java/main", "major": 52, "build": ".\\gradlew.bat classes" }
```

- 바뀐 `Foo.java` → `Foo.class` 와 내부 클래스 `Foo$1.class`, `Foo$Inner.class` 를 함께 올립니다.
- `major` 는 class 파일 버전입니다(Java 8 = 52, 11 = 55, 17 = 61). 다르면 막습니다.
- class 가 소스보다 오래됐으면(빌드 안 함) 막습니다. 소스보다 오래된 **내부 클래스**는 지운 클래스의 찌꺼기로 보고 올리지 않습니다.
- `build` 는 안내용입니다. 패널이 빌드하지 않고, 빌드가 필요할 때 이 명령을 보여 줍니다.

#### 손 처리 규칙

패턴에 걸리는 파일은 **올리지 않고** 이유와 함께 보여 줍니다(운영 서버가 다른 파일을 쓰는 설정 파일, jar 교체 등). 위에서부터 처음 맞는 규칙을 씁니다.

- `**` 는 폴더를 넘어 아무 경로나, `*` 와 `?` 는 폴더 안에서만 맞습니다.

```json
"manual": [
  { "pattern": "src/main/webapp/WEB-INF/web.xml", "reason": "운영 서버가 별도 파일을 씀 — 필요한 변경만 손으로" },
  { "pattern": "src/main/resources/**",          "reason": "환경별 설정 — 손으로" },
  { "pattern": "libs/**",                         "reason": "jar 교체 — 백업·재기동과 함께 손으로" }
]
```

판정 순서: **손 처리 규칙 → 삭제된 파일(늘 손 처리, 운영에서 자동으로 지우지 않음) → 경로 매핑 → 매핑 밖 파일(운영과 상관없음)**.

### 3-3. 접속 정보 저장

FTP 사용자·비밀번호는 각자 PC 의 **Windows 자격 증명 관리자**에 `prod-deploy:<대상 이름>` 으로 저장합니다. 저장소·설정 파일·로그에는 남지 않습니다.

- 패널: 대상 설정 탭 → **접속 정보** → 사용자·비밀번호 → **접속 정보 저장**
- CLI: 첫 줄 사용자, 둘째 줄 비밀번호를 stdin 으로. 아래처럼 쓰면 PowerShell 기록에 비밀번호가 남을 수 있으니 되도록 패널에서 넣으세요.

```powershell
"ftpuser`nftppassword" | node src/cli.ts creds myapp set
node src/cli.ts creds myapp status
```

### 3-4. 설정 확인

대상을 만들거나 매핑을 고친 뒤, **확인용 커밋**(이미 운영에 반영된 커밋)을 넣고 대상 설정 탭의 **설정 확인**을 누릅니다. 그 커밋으로 plan 을 돌려(운영 읽기만) 모든 파일이 "이미 반영됨"으로 나오면 매핑이 맞는 것입니다. 운영에 없는 경로(새 파일)가 나오면 매핑이 틀린 것입니다.

## 4. 반영하기

반영 전 준비(사람이 함): PR 을 main 에 병합 → **메인 체크아웃을 main 으로 바꾸고 pull** → Java 가 바뀌었으면 메인 체크아웃에서 빌드.

패널에서 누르는 것은 두 번입니다.

1. PR 을 고르고 **반영 목록 만들기** → 준비 확인 → plan → 백업(운영은 읽기만)
2. **`<대상 이름>에 N개 업로드`** → 직전 재대조 → 업로드 → 대조

상태 표시줄의 **운영 반영**을 누르면 패널이 열리고, 패널이 보일 때 다시 누르면 오른쪽 사이드바가 닫힙니다.

### 4-1. 대상

패널은 지금 Orca 작업공간의 저장소로 대상을 고릅니다. 못 고르면 마지막에 고른 대상을 쓰고, 그것도 없으면 직접 고르게 합니다(시험용 대상은 자동으로 고르지 않습니다). FTP 주소·운영 루트·메인 체크아웃이 늘 보입니다. 작업공간 저장소와 대상의 저장소가 다르면 경고합니다.

### 4-2. 반영할 PR → 반영 목록 만들기

"반영할 PR" 카드에 대상 저장소 main 에 최근 병합된 PR 이 나옵니다(`gh pr list`). 이 패널로 이미 올린 PR 은 **반영됨**, 목록까지 만든 PR 은 **목록 만듦**으로 표시합니다. PR 을 누르면 고르기만 합니다(아래 칸에 `#번호`가 채워짐). 커밋 해시나 `기준..끝` 구간은 그 칸에 직접 넣습니다. **반영 목록 만들기**를 누르면 아래를 차례로 합니다. **초기화**는 고른 PR·준비 확인·열린 반영 목록을 비우고 처음 화면으로 돌아갑니다(만든 run 은 run 기록에 남음).

**준비 확인** — 하나라도 실패하면 여기서 멈추고 할 일을 보여 줍니다(명령은 선택해서 복사). 고친 뒤 **다시 확인**.

| 확인 | 실패하면 |
|---|---|
| PR 이 병합됐는가 / 커밋이 main 에 있는가 | 병합부터 |
| 메인 체크아웃이 main 브랜치인가 | `git switch main` |
| main pull 이 됐는가(반영 커밋 포함, origin/main 보다 뒤처지지 않음) | `git pull --ff-only` |
| 바뀐 파일에 커밋 안 한 수정이 없는가 | 수정 정리 |
| 바뀐 Java 의 class 가 main 소스로 빌드됐는가(있음·소스보다 새것·버전) | 빌드 명령 |

**plan (운영 읽기만)** — 바뀐 파일을 운영 경로로 바꾸고, 운영의 지금 파일을 받아 반영 커밋·직전 커밋과 대조합니다.

- **반영 목록**: 파일마다 덮어씀/새 파일, 로컬 → 운영 경로, 메모
- 손 처리 파일, 매핑 밖 파일, 빌드 폴더의 옛 내부 클래스(올리지 않음)
- PR 본문의 "반영 시 주의" 절
- **문제**: 하나라도 있으면 그 run 은 올리지 못합니다. 고친 뒤 다시 만듭니다.
  - 운영본이 이미 반영 커밋과 같음(이미 반영됨?)
  - 운영본이 직전 커밋과 다름(운영에만 있는 수정?)
  - 저장소엔 새 파일인데 운영에 이미 있음
  - main 에 이후 변경 있음(HEAD 파일 ≠ 반영 커밋)
  - 커밋 안 한 수정, class 없음·오래됨·버전 다름
  - 운영 폴더 목록을 확인할 수 없음(권한·시간 초과)
- **확인 코드**: 이 대상과 반영 목록을 가리키는 8자리 코드

**백업** — 문제가 없으면 이어서 덮어쓸 운영 파일을 run 폴더에 받고 plan 때와 같은지 확인합니다. 백업이 실패하면 run 카드에 **백업** 버튼이 나옵니다.

### 4-3. 업로드 (→ 대조)

버튼에 `<대상 이름>에 N개 업로드` 가 적혀 있습니다. **이 버튼을 누르는 것이 최종 확인입니다.**

1. 업로드 직전에 브랜치·HEAD·로컬 파일·운영 파일을 다시 확인하고, 승인한 바이트를 고정본으로 떠서 그것만 올립니다(파일마다 임시 이름으로 올린 뒤 이름 바꾸기, 다시 받아 대조).
2. 다 올리면 이어서 운영 파일이 올린 파일과 같은지(sha256) 대조합니다. 대조가 맞지 않으면 **다시 대조** 버튼과 되돌리기가 나옵니다.

끝나면 남은 사람 할 일(톰캣 재기동, PR 의 SQL·등록 순서, 재로그인 확인, 반영 이력 기록)을 보여 줍니다. 오래 걸리는 단계는 상태 표시줄과 알림으로도 알려 줍니다. 패널을 닫아도 업로드는 끝까지 갑니다.

## 5. 되돌리기

run 카드의 **되돌리기**: 덮어쓴 파일은 백업으로 되올리고, 새로 만든 파일은 지웁니다.

- 업로드가 중간에 멈춘 run(**부분 업로드**)은 이어 올리지 않습니다. 되돌린 뒤 새로 plan 합니다.
- 이 run 보다 **나중에 올린 run 이 같은 운영 파일**을 건드렸으면 막습니다(그 run 을 먼저 되돌리세요).
- 올린 뒤 **운영 파일이 누군가에 의해 바뀌었으면** 막습니다(손으로 확인).
- 되돌린 run 은 다시 올리지 않습니다. 새로 plan 합니다.

## 6. 안전장치

- 대상을 바꾸거나 대상 설정을 저장하면 준비 확인·plan·확인 코드를 버립니다.
- run 에는 그때의 대상 설정 사본이 남고, 지금 설정과 다르면 그 run 은 백업·업로드할 수 없습니다(되돌리기는 run 에 적힌 주소로).
- 확인 코드가 승인한 plan 과 다르면 올리지 않습니다.
- 백업 전에는 올리지 않고, 백업이 plan 때 운영본과 다르면 올리지도 되돌리지도 않습니다.
- 대상마다 잠금: 백업·업로드·대조·되돌리기는 한 번에 하나만. 끝난 작업이 잠금을 남겼으면 자동으로 치우지 않고, 사람이 **잠금 풀기**로 풉니다.
- FTP 목록을 확실히 받지 못하면 "파일 없음"으로 보지 않고 멈춥니다.
- 접속 정보는 stdin 으로만 curl·PowerShell 에 넘깁니다(명령줄·로그에 남지 않음).

## 7. CLI (Claude 스킬·비상용)

패널과 같은 엔진을 명령으로 씁니다. 평소에는 패널을 쓰고, **업로드·되돌리기는 패널을 못 쓸 때만** CLI 로 합니다.

```powershell
node src/cli.ts targets                             # 대상 목록
node src/cli.ts check  --target myapp "#123"        # 준비 확인
node src/cli.ts plan   --target myapp "#123" --backup   # plan(+백업) → run 이름·확인 코드
node src/cli.ts backup <run>
node src/cli.ts upload <run> --plan <확인 코드> --yes   # 올리고 이어서 대조
node src/cli.ts verify <run>
node src/cli.ts rollback <run> --plan <확인 코드> --yes
node src/cli.ts runs   --target myapp               # 지난 run
node src/cli.ts show   <run>                        # run 내용
node src/cli.ts unlock myapp                        # 끝난 작업이 남긴 잠금 풀기
node src/cli.ts creds  myapp status|set|delete      # 접속 정보
```

`--target` 을 빼면 지금 폴더의 저장소로 대상을 찾습니다.

### Claude Code 스킬

`skill/prod-deploy/` 에 Claude Code 스킬(`SKILL.md`)과 확인 훅(`guard-hook.sh`)이 있습니다. Claude 는 준비 확인·plan·backup·verify 를 CLI 로 하고, **업로드·되돌리기는 패널에서 사람이 누르도록 안내**합니다. 사람이 "패널을 못 쓴다"고 할 때만 반영 목록을 보여 주고 승인을 받은 뒤 CLI 로 올립니다.

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

`permissions.ask` 는 명령 모양이 정확히 맞을 때만 걸리므로, 따옴표·`cd`·환경변수가 붙어도 잡히도록 훅을 함께 둡니다. 훅은 `cli.ts` 의 `upload`·`rollback`·`unlock`·`creds` 에서 확인 창을 띄웁니다(`test/guard-hook.spec.ts`).

## 8. 데이터 위치와 run 기록

| 무엇 | 어디 |
|---|---|
| 대상 설정 | `~/.prod-deploy/targets/<대상>.json` (이전 설정: `.history/`, 지운 설정: `.deleted/`) |
| 접속 정보 | Windows 자격 증명 관리자 `prod-deploy:<대상>` |
| run 기록 | 대상 설정의 `runs` 폴더, `<대상>-<YYYYMMDD-HHMMSS>-<커밋 8자리>/` |
| run 위치 색인 | `~/.prod-deploy/run-index/` |
| 잠금·작업 진행 | `~/.prod-deploy/locks/`, `~/.prod-deploy/jobs/` |

run 폴더: `meta.env`(대상·기준·반영 커밋·HEAD), `plan.tsv`(반영 목록), `errors.txt`(문제), `manual.tsv`·`skip.tsv`·`notes.tsv`, `target.json`(그때의 설정), `backup/`, `deploy.log`, 단계별 완료 표시(`plan.done`, `backup.done`, `upload.started`, `upload.done`, `verify.done`, `rollback.done`).

확인 코드 = `sha256(대상 이름 + "\n" + plan.tsv)` 의 앞 8자리.

## 9. 제한과 주의

- **여러 PC 에서 같은 서버에 동시에 반영하는 경우를 막지 못합니다.** 잠금과 run 기록이 PC 마다 따로입니다. 업로드 직전·되돌리기 전에 운영 파일을 다시 대조하므로 대부분의 충돌은 잡히지만, 같은 대상에 반영하는 사람끼리 미리 맞추세요.
- FTP 만 지원합니다(FTPS·SFTP 없음).
- 삭제된 파일은 운영에서 자동으로 지우지 않습니다(손 처리로 보여 줌).
- class 파일은 운영본과의 대조(이미 반영됨·운영에만 있는 수정)를 하지 않습니다.
- 메인 체크아웃의 빌드·pull 은 패널이 하지 않습니다.

## 10. 문제 해결

| 증상 | 할 일 |
|---|---|
| 패널에 "대상이 없음" | 대상 설정 탭에서 대상을 만들거나, **다시 불러오기**(↻) |
| "워커에 연결하지 못함" | `orca plugin logs <플러그인 이름>` 으로 오류 확인 (`orca plugin list` 로 이름 확인) |
| "끝난 작업의 잠금이 남아 있음" | 그 작업이 정말 끝났는지(다른 창·터미널) 본 뒤 **잠금 풀기** 또는 `node src/cli.ts unlock <대상>` |
| "접속 정보 없음" | 3-3 대로 접속 정보 저장 |
| "운영 폴더 목록을 확인할 수 없음" | FTP 계정의 목록 권한·네트워크 확인. 있는지 없는지 모르면 진행하지 않습니다. |
| "대상 설정이 plan 이후 바뀜" | 새로 plan |
| PR 을 찾지 못함 | `gh auth status`, 메인 체크아웃의 origin 이 그 GitHub 저장소인지 |

## 11. 개발

```
src/engine/   엔진 (TS, 빌드 단계 없음) — 대상 설정, git, FTP(curl), plan·백업·업로드·대조·되돌리기, run 기록
src/cli.ts    CLI
src/worker.ts 플러그인 워커: 짧은 일은 엔진을 직접, 운영 FTP 단계는 CLI 프로세스를 따로 띄움(ADR 0002)
src/panel.tsx 패널(Orca components), src/protocol.ts 패널↔워커 약속
examples/     대상 설정 예시
test/         엔진 단위·안전 시험, e2e, 시험 FTP 서버
```

시험:

```powershell
node --test test/engine.spec.ts test/safety.spec.ts test/guard-hook.spec.ts   # 엔진 단위·안전 회귀·스킬 훅
orca plugin test .                                    # 패널·워커
orca plugin check .                                   # 패널을 워커와 함께 한 번 그리기
node test/e2e.ts                                      # 임시 저장소 + 시험 FTP 로 전체 흐름
```

e2e 와 시험용 대상에는 시험 FTP 서버(pyftpdlib)가 필요합니다.

```powershell
python -m venv $HOME\.prod-deploy\test-ftp\venv
& $HOME\.prod-deploy\test-ftp\venv\Scripts\python.exe -m pip install pyftpdlib
# 시험용 대상을 쓸 때: 시험할 저장소를 ~/.prod-deploy/test-repo 로 복제하고 대상 설정·접속 정보(test/test)를 넣은 뒤
git clone <시험할 저장소> $HOME\.prod-deploy\test-repo
copy examples\local-test.json $HOME\.prod-deploy\targets\test.json
"test`ntest" | node src/cli.ts creds test set
# 시험 FTP 루트를 그 커밋의 직전 상태로 채우고 서버 띄우기
node test/seed-test-ftp.ts <커밋>
& $HOME\.prod-deploy\test-ftp\venv\Scripts\python.exe -I test/ftp-server.py $HOME\.prod-deploy\test-ftp\root 2121
```

Orca 1.4.250 설치본에는 플러그인 타입 파일이 빠져 있어 `orca plugin types` 가 실패할 수 있습니다. 그때는 같은 버전 태그(`stablyai/orca`)의 `resources/plugins/types/*.d.ts`, `resources/plugins/declarative/*.d.ts` 를 `.orca/types/` 에 받아 두면 됩니다.
