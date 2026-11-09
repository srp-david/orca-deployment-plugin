#!/usr/bin/env bash
# PreToolUse 훅 (Bash|PowerShell): 운영 반영 CLI 의 쓰기·안전장치 해제 명령이면 사람 확인을 강제한다.
# 명령 표기(경로·따옴표·cd·환경변수 앞붙임)가 달라도 잡도록 permissions.ask 와 별도로 둔다.
#   - cli.ts upload|rollback|unlock|creds|ack  (이 저장소의 CLI. ack 는 경고를 사람이 판단했다는 표시)
#   - deploy.sh upload|rollback            (예전 bash 도구)
# 입력은 JSON 이라 명령 안의 따옴표는 \" 로 온다. ([^"\\]|\\.)* 로 명령 문자열 밖으로 넘어가지 않고,
# 단계 이름 앞뒤의 \" 도 허용한다.
input=$(cat)
cmd='([^"\\]|\\.)*([[:space:]]|\\")'
end='([[:space:]]|\\|"|$)'
if printf '%s' "$input" | grep -Eq "(cli\.ts${cmd}(upload|rollback|unlock|creds|ack)|deploy\.sh${cmd}(upload|rollback))${end}"; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"운영 반영 CLI(prod-deploy upload/rollback/unlock/creds/ack). 대화에서 보여 준 반영 목록·대상·확인 코드와 같은지 보고 승인하세요."}}'
fi
exit 0
