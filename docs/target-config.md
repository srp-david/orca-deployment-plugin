# 대상 설정

**대상**은 반영할 곳 하나입니다: 저장소 하나 + FTP 주소 + 운영 루트. 같은 저장소에 운영·시험 대상을 여러 개 둘 수 있습니다.

대상 설정은 각자 PC 의 `~/.prod-deploy/targets/<대상 이름>.json` 에 저장됩니다(저장소에는 올라가지 않음). 패널의 **대상 설정** 탭에서 만들고 고치며, 파일을 직접 고쳐도 됩니다. 저장할 때마다 이전 설정은 `targets/.history/` 에, 지운 설정은 `targets/.deleted/` 에 남습니다.

예시: [`examples/java-war.json`](../examples/java-war.json)

```powershell
mkdir $HOME\.prod-deploy\targets -Force
copy examples\java-war.json $HOME\.prod-deploy\targets\myapp.json
notepad $HOME\.prod-deploy\targets\myapp.json   # id 는 파일 이름과 같아야 함
```

## 항목

| 항목 | 설명 | 예 |
|---|---|---|
| `id` | 대상 이름. 영문 소문자·숫자·`_` 만(`-` 는 안 됨). **만든 뒤에는 바꿀 수 없습니다**(run 기록이 이름에 묶임). | `myapp` |
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

`repo`·`runs` 의 `~` 는 홈 폴더로 바뀝니다.

## 경로 매핑

저장소의 폴더 하나를 운영 루트 아래 폴더 하나에 잇습니다. 바뀐 파일이 여러 매핑에 걸리면 **로컬 경로가 가장 긴(가장 구체적인) 매핑**을 씁니다. 매핑은 폴더 단위이고 `*` 같은 패턴은 쓰지 않습니다.

```json
"mappings": [
  { "local": "src/main/webapp",          "remote": "/" },
  { "local": "build/classes/java/main",  "remote": "/WEB-INF/classes" }
]
```

`src/main/webapp/ui/a.xml` → `/webapps/ROOT/ui/a.xml`

## Java 빌드 출력

git diff 에는 `.java` 만 나오므로, 바뀐 `.java` 를 빌드 결과 `.class` 로 바꿔 올립니다(IntelliJ 모듈의 Compiler output 과 같은 개념). 빌드 결과 폴더도 경로 매핑에 있어야 합니다.

```json
"java": { "source": "src/main/java", "output": "build/classes/java/main", "major": 52, "build": ".\\gradlew.bat classes" }
```

- 바뀐 `Foo.java` → `Foo.class` 와 내부 클래스 `Foo$1.class`, `Foo$Inner.class` 를 함께 올립니다.
- `major` 는 class 파일 버전입니다(Java 8 = 52, 11 = 55, 17 = 61). 다르면 막습니다.
- class 가 소스보다 오래됐으면(빌드 안 함) 막습니다. 소스보다 오래된 **내부 클래스**는 지운 클래스의 찌꺼기로 보고 올리지 않습니다.
- `build` 는 안내용입니다. 패널은 빌드하지 않고, 빌드가 필요할 때 이 명령을 보여 줍니다.
- 같은 `.java` 에 함께 선언한 다른 최상위 class(class 의 SourceFile 이 그 파일인 것)도 함께 올립니다.
- **상수 값 대조**: plan 때 운영 class 와 새 class 의 컴파일 시간 상수(`final` 기본형·문자열 필드)를 비교합니다. Java 는 상수를 쓰는 쪽 class 에 값을 복사해 넣으므로, 값이 바뀌거나 상수가 아니게 되면(일반 필드로 바뀜, 없어짐) 쓰는 class 도 다시 올려야 합니다.
  - 쓰는 소스 후보: 상수 이름이 낱말로 나오는 `.java` 전부입니다. Java 는 상수를 여러 길로 부를 수 있어서(`Foo.LIMIT`, `import static`, 상속받아 `LIMIT`, `식.LIMIT`) class 이름으로 거르지 않습니다.
  - 후보가 이 반영 목록에 없으면 **경고**로 그 파일들을 보여 줍니다. 같은 이름의 다른 상수·지역 변수·주석까지 후보가 되므로, 사람이 열어 보고 판단합니다. 사람이 **확인함**을 눌러야 업로드됩니다(누가·언제 확인했는지 run 에 남음). 정말 그 상수를 쓰면 그 class 도 올려야 하니 그 run 은 쓰지 않습니다.
  - 후보가 없거나 반영 목록에 다 있으면 **참고**에만 적습니다. 소스에 이름을 `\uXXXX` 로 적은 경우는 찾지 못합니다.
  - 같은 폴더의 class 중 소스 파일 이름(SourceFile)이 없는 것이 있으면 막습니다(어느 소스에서 나왔는지 알 수 없음). 보통의 javac·Gradle 빌드에는 늘 들어 있습니다.
  - `private` 상수는 같은 파일 안에서만 쓰이므로 보지 않습니다. 운영에 없던 새 class 는 비교할 것이 없어 class 형식만 확인합니다.
  - 이미 운영에서 옛 값을 쓰고 있는 class(예전 반영에서 빠진 것)는 찾지 못합니다.
- class 의 나머지 내용은 운영본과 대조하지 않습니다(직전 커밋의 class 가 없음). 업로드 직후 대조는 class 도 합니다.

빌드가 `src/main/java` 아래의 `.java` 가 아닌 파일(메일 템플릿 등)도 `WEB-INF/classes` 로 넣는 프로젝트라면, 그 폴더도 경로 매핑에 넣습니다. `.java` 는 위 규칙이 먼저 처리하고, 나머지 파일은 소스 그대로 올라갑니다.

```json
{ "local": "src/main/java", "remote": "/WEB-INF/classes" }
```

## 손 처리 규칙

패턴에 걸리는 파일은 **올리지 않고** 이유와 함께 보여 줍니다(운영 서버가 다른 파일을 쓰는 설정 파일, jar 교체 등). 위에서부터 처음 맞는 규칙을 씁니다. `**` 는 폴더를 넘어 아무 경로나, `*` 와 `?` 는 폴더 안에서만 맞습니다.

```json
"manual": [
  { "pattern": "src/main/webapp/WEB-INF/web.xml", "reason": "운영 서버가 별도 파일을 씀 — 필요한 변경만 손으로" },
  { "pattern": "src/main/resources/**",          "reason": "환경별 설정 — 손으로" },
  { "pattern": "libs/**",                         "reason": "jar 교체 — 백업·재기동과 함께 손으로" }
]
```

바뀐 파일의 판정 순서: **손 처리 규칙 → 삭제된 파일(늘 손 처리, 운영에서 자동으로 지우지 않음) → 경로 매핑 → 매핑 밖 파일(운영과 상관없음)**.

단 `src/main/` 아래 파일은 빌드가 WAR 에 넣는 곳이라 매핑 밖 파일로 조용히 빠지지 않습니다. 추가·수정은 **문제**로 막습니다(경로 매핑을 추가하거나, 올리지 않을 파일이면 손 처리 규칙에 넣으세요). 삭제는 손 처리 파일로 남깁니다.

## 접속 정보

FTP 사용자·비밀번호는 각자 PC 의 **Windows 자격 증명 관리자**에 `prod-deploy:<대상 이름>` 으로 저장합니다. 패널의 대상 설정 탭 → **접속 정보** 카드에서 넣습니다. CLI 로 넣는 방법은 [cli-and-skill.md](cli-and-skill.md).

예전 bash 도구에서 옮겨 오는 동안에는 대상 설정에 `legacyNetrc`(netrc 파일 경로)를 둘 수 있습니다. 자격 증명 관리자에 정보가 있으면 그것을 쓰고, 없을 때만 netrc 를 씁니다(파일 내용은 읽지 않고 curl 에 경로만 넘김).

## 설정 확인

대상을 만들거나 매핑을 고친 뒤 **확인용 커밋**을 넣고 대상 설정 탭의 **설정 확인**을 누릅니다. 그 커밋으로 plan 을 돌려(운영 읽기만) 판정합니다.

| 결과 | 뜻 |
|---|---|
| 설정 맞음 | 파일이 "이미 반영됨"으로 나옴. 그 뒤 main 에서 다시 바뀐 파일은 빼고 봅니다. |
| 설정 확인 필요 | 운영에 없는 경로(새 파일)가 나옴 → 매핑·운영 루트가 틀림. 또는 운영에만 있는 수정이 있음. |
| 설정 확인 실패 | 접속·준비 확인에서 멈춤 |

설정 확인으로 만든 run 도 run 기록에 남습니다(막힘). 필요 없으면 run 기록 탭의 **목록 비우기**로 숨기세요.
