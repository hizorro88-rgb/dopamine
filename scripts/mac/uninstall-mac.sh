#!/usr/bin/env bash
# 🍎 맥 서버 자동 실행 해제 — launchd 서비스(서버+터널)를 중지·삭제합니다.
#    (잠자기 설정 pmset 은 그대로 둡니다. 되돌리려면: sudo pmset -c sleep 1 disablesleep 0)
set -u
AGENTS="$HOME/Library/LaunchAgents"
for name in kr.dopamine.server kr.dopamine.tunnel; do
  plist="$AGENTS/$name.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" >/dev/null 2>&1 || true
    rm -f "$plist"
    echo "  ✓ 제거됨: $name"
  fi
done
echo "완료. 서버·터널 자동 실행이 해제되었습니다."
