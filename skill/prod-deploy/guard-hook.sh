#!/usr/bin/env bash
# PreToolUse 훅 (Bash|PowerShell): 운영 반영 CLI 의 쓰기·안전장치 해제 명령이면 사람 확인을 강제한다.
# 명령 표기(경로·따옴표·cd·환경변수 앞붙임)가 달라도 잡도록 permissions.ask 와 별도로 둔다.
#   - cli.ts upload|rollback|unlock|creds  (이 저장소의 CLI)
#   - cli.ts prune ... --yes               (백업 정리: 되살릴 수 없음. --yes 없는 목록 보기는 통과)
#   - deploy.sh upload|rollback            (예전 bash 도구)
# 입력은 JSON 이라 명령 안의 따옴표는 \" 로 온다. ([^"\\]|\\.)* 로 명령 문자열 밖으로 넘어가지 않고,
# 단계 이름 앞뒤의 \" 와 ' 도 허용한다('--yes'·'upload' 처럼 작은따옴표로 감싸도 셸은 같은 인자로 넘긴다).
input=$(cat)
q="'"
cmd='([^"\\]|\\.)*([[:space:]]|\\"|'"$q"')'
end='([[:space:]]|\\|"|'"$q"'|$)'
if printf '%s' "$input" | grep -Eq "(cli\.ts${cmd}(upload|rollback|unlock|creds)|cli\.ts${cmd}prune${cmd}--yes|deploy\.sh${cmd}(upload|rollback))${end}"; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"운영 반영 CLI(prod-deploy upload/rollback/unlock/creds/prune --yes). 대화에서 보여 준 반영 목록·대상·확인 코드(백업 정리는 지울 run 목록과 그 확인 코드)와 같은지 보고 승인하세요."}}'
fi
exit 0
