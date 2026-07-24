#!/usr/bin/env bash
# 🍎 더블클릭으로 서버를 '앞단(터미널)'에서 바로 실행 — 첫 테스트/디버깅용.
#    (서비스로 항상 켜두려면 setup-mac.sh 를 한 번 실행하세요.)
#    이 창을 닫으면 서버가 멈춥니다.
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
echo "██████  DOPAMINE — 앞단 실행 (git 자동배포 감시 포함)  ██████"
echo "  로컬 확인:  http://localhost:3000"
echo "  (이 창을 닫으면 서버가 종료됩니다)"
echo
exec node scripts/autodeploy.js
