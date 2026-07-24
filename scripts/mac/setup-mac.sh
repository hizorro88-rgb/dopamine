#!/usr/bin/env bash
#
# 🍎 DOPAMINE — 맥(macOS) 전용 서버 설치 스크립트 (안 쓰는 맥북을 24시간 서버로)
# ────────────────────────────────────────────────────────────────────
#  이 스크립트 하나로 아래를 자동 설정합니다:
#    1) 잠자기 방지 + 정전 후 자동 재시작 (pmset)
#    2) 서버 자동 실행 서비스 등록 (launchd) — 부팅 시 자동 시작 + 죽으면 되살림
#       └ scripts/autodeploy.js 를 돌려 git 새 커밋이 올라오면 자동으로 받아 재시작
#    3) Cloudflare Tunnel 자동 실행 서비스 등록 (도메인 연결)
#
#  실행:  bash scripts/mac/setup-mac.sh
#  (한 번만 실행하면 됩니다. 다시 실행해도 안전 — 기존 설정을 갱신합니다.)
#
#  ⚠️ 사전 준비
#    - Node 18+ 설치 (https://nodejs.org 또는  brew install node)
#    - (도메인 쓸 경우) cloudflared 설치 + 터널 생성이 이미 되어 있어야 함
#         brew install cloudflared
#         cloudflared tunnel login
#         cloudflared tunnel create pinball
#         cloudflared tunnel route dns pinball dopamine.me.kr
#
set -euo pipefail

# ── 경로/환경 파악 ───────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_BIN="$(command -v node || true)"
GIT_BIN="$(command -v git || true)"
CF_BIN="$(command -v cloudflared || true)"
USER_NAME="$(whoami)"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }

echo
bold "██████  DOPAMINE 맥 서버 설치  ██████"
echo "  저장소:  $REPO_DIR"
echo "  사용자:  $USER_NAME"
echo

# ── 0) 필수 도구 확인 ────────────────────────────────────────────
if [ -z "$NODE_BIN" ]; then
  echo "❌ Node 가 없습니다. https://nodejs.org 에서 설치하거나  brew install node  후 다시 실행하세요."
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
ok "Node: $($NODE_BIN -v)  ($NODE_BIN)"
[ -n "$GIT_BIN" ] && ok "git: $GIT_BIN" || warn "git 이 없습니다 — 자동배포가 동작하지 않습니다 (xcode-select --install 로 설치)"
[ -n "$CF_BIN" ] && ok "cloudflared: $CF_BIN" || warn "cloudflared 가 없습니다 — 터널 서비스는 건너뜁니다 (brew install cloudflared)"

# ── 1) .env 준비 ────────────────────────────────────────────────
if [ ! -f "$REPO_DIR/.env" ]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  warn ".env 를 새로 만들었습니다 →  $REPO_DIR/.env  를 열어 ADMIN_KEY 등을 채워주세요."
else
  ok ".env 확인됨"
fi
# PORT 값 읽기 (없으면 3000)
PORT="$(grep -E '^PORT=' "$REPO_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' \r' || true)"
[ -z "${PORT:-}" ] && PORT=3000
ok "포트: $PORT"

# ── 2) 의존성 설치 ──────────────────────────────────────────────
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "  📦 npm install 중..."
  ( cd "$REPO_DIR" && "$NODE_DIR/npm" install --omit=dev )
  ok "의존성 설치 완료"
else
  ok "node_modules 존재"
fi
mkdir -p "$REPO_DIR/logs"

# ── 3) 잠자기 방지 + 정전 후 자동 재시작 (sudo 필요) ─────────────
echo
bold "① 잠자기 방지 / 정전 자동복구 (pmset — 관리자 암호가 필요할 수 있어요)"
if sudo -v 2>/dev/null; then
  # 전원 연결 시: 시스템/디스크 잠자기 끔, 네트워크로 깨우기 허용, 정전 후 자동 켜짐
  sudo pmset -c sleep 0 disksleep 0 womp 1 autorestart 1 >/dev/null 2>&1 || true
  # 덮개 닫고도 계속 켜두고 싶으면 아래 주석을 해제하세요(클램셸 모드).
  # sudo pmset -c disablesleep 1 >/dev/null 2>&1 || true
  ok "전원 연결 시 잠자기 해제 · 정전 후 자동 시작 설정됨"
  warn "덮개를 닫고 쓰려면:  sudo pmset -c disablesleep 1  (되돌리기: ... disablesleep 0)"
else
  warn "sudo 를 건너뜀 — 나중에 직접:  sudo pmset -c sleep 0 disksleep 0 womp 1 autorestart 1"
fi

# ── 4) 서버 자동 실행 서비스 (launchd LaunchAgent) ──────────────
echo
bold "② 서버 자동 실행 등록 (launchd)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"
SRV_PLIST="$AGENTS/kr.dopamine.server.plist"
SRV_PATH="$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cat > "$SRV_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>kr.dopamine.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/scripts/autodeploy.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_DIR/logs/server.log</string>
  <key>StandardErrorPath</key><string>$REPO_DIR/logs/server.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$SRV_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

launchctl unload "$SRV_PLIST" >/dev/null 2>&1 || true
launchctl load -w "$SRV_PLIST"
ok "서버 서비스 등록됨 (kr.dopamine.server) — 부팅 시 자동 시작 + 죽으면 자동 재시작"
ok "로그:  $REPO_DIR/logs/server.log"

# ── 5) Cloudflare Tunnel 자동 실행 서비스 ───────────────────────
echo
bold "③ Cloudflare Tunnel 자동 실행 등록"
if [ -n "$CF_BIN" ]; then
  TUNNEL_NAME="${DOPAMINE_TUNNEL:-pinball}"   # 다른 터널명이면  DOPAMINE_TUNNEL=이름 bash ...
  TUN_PLIST="$AGENTS/kr.dopamine.tunnel.plist"
  cat > "$TUN_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>kr.dopamine.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CF_BIN</string>
    <string>tunnel</string>
    <string>run</string>
    <string>--url</string>
    <string>http://localhost:$PORT</string>
    <string>$TUNNEL_NAME</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_DIR/logs/tunnel.log</string>
  <key>StandardErrorPath</key><string>$REPO_DIR/logs/tunnel.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$SRV_PATH</string>
  </dict>
</dict>
</plist>
PLIST
  launchctl unload "$TUN_PLIST" >/dev/null 2>&1 || true
  launchctl load -w "$TUN_PLIST"
  ok "터널 서비스 등록됨 (터널명: $TUNNEL_NAME) → 도메인으로 접속 가능"
  ok "로그:  $REPO_DIR/logs/tunnel.log"
else
  warn "cloudflared 미설치 → 터널 서비스 건너뜀. 도메인 쓰려면 위 '사전 준비' 참고 후 다시 실행."
fi

# ── 마무리 안내 ─────────────────────────────────────────────────
echo
bold "✅ 설치 완료!"
echo
echo "  서버:   http://localhost:$PORT  (로컬 확인)"
echo "  상태:   launchctl list | grep dopamine"
echo "  로그:   tail -f $REPO_DIR/logs/server.log"
echo "  중지:   launchctl unload ~/Library/LaunchAgents/kr.dopamine.server.plist"
echo "  시작:   launchctl load -w ~/Library/LaunchAgents/kr.dopamine.server.plist"
echo
bold "🔧 마지막으로 시스템 설정에서 이 2개만 켜주세요 (한 번만):"
echo "   • 사용자 및 그룹 → 자동 로그인  (재부팅 후 바로 로그인되어 서비스가 뜨게)"
echo "   • 에너지 절약 → '정전 후 자동으로 시작'  (pmset autorestart 로 이미 설정됨)"
echo "   • .env 의 ADMIN_KEY 를 나만 아는 값으로 채웠는지 확인"
echo
