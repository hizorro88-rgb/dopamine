#!/usr/bin/env bash
#
# 🍎 DOPAMINE — macOS Big Sur (11) 전용 부트스트랩
# ────────────────────────────────────────────────────────────────────
#  Big Sur 는 Homebrew 지원이 끊겨 `brew install node` 가 불안정하고,
#  Node 22 는 아예 안 돕니다(11 미지원). 그래서 이 스크립트가:
#    1) Xcode Command Line Tools(git/컴파일러) 확인
#    2) Node 20 LTS 를 Apple 공식 pkg 로 자동 설치 (Big Sur 에서 검증된 마지막 라인)
#    3) cloudflared 를 GitHub 릴리스에서 직접 설치 (도메인용, 선택)
#  를 자동으로 깔고, 이어서 scripts/mac/setup-mac.sh 를 실행해
#  잠자기 방지 + 자동 실행 + 자동 배포 + 터널까지 한 번에 마무리합니다.
#
#  실행:  bash scripts/mac/bootstrap-bigsur.sh
#  (다시 실행해도 안전 — 이미 있는 건 건너뜁니다.)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "\033[31m❌ %s\033[0m\n" "$1"; exit 1; }

echo
bold "██████  DOPAMINE — Big Sur 부트스트랩  ██████"

# ── 0) macOS 버전 확인 ──────────────────────────────────────────
OS_VER="$(sw_vers -productVersion 2>/dev/null || echo '0')"
OS_MAJOR="${OS_VER%%.*}"
echo "  macOS: $OS_VER"
if [ "$OS_MAJOR" -lt 11 ]; then
  die "이 스크립트는 Big Sur(11) 이상에서만 쓰세요. 현재 $OS_VER"
fi
[ "$OS_MAJOR" -eq 11 ] && ok "Big Sur 확인" || warn "11 보다 높은 버전 — 그냥 진행합니다(문제없음)"

ARCH="$(uname -m)"   # 2013 맥북프로는 x86_64(Intel)
echo "  CPU: $ARCH"

# ── 1) Xcode Command Line Tools (git 포함) ──────────────────────
echo
bold "① git / 컴파일러 (Xcode Command Line Tools)"
if xcode-select -p >/dev/null 2>&1; then
  ok "이미 설치됨: $(xcode-select -p)"
else
  warn "설치 창을 띄웁니다 — '설치' 버튼을 눌러 끝난 뒤 이 스크립트를 다시 실행하세요."
  xcode-select --install || true
  die "Command Line Tools 설치를 마친 후 다시 실행: bash scripts/mac/bootstrap-bigsur.sh"
fi

# ── 2) Node 20 LTS 설치 (Apple 공식 pkg) ────────────────────────
echo
bold "② Node.js (Big Sur 는 20 LTS 권장 — 22 는 미지원)"
need_node=1
if command -v node >/dev/null 2>&1; then
  CUR="$(node -v)"            # 예: v20.18.1
  CUR_MAJOR="$(printf '%s' "$CUR" | sed -E 's/^v([0-9]+).*/\1/')"
  if [ "$CUR_MAJOR" -ge 18 ] && [ "$CUR_MAJOR" -le 20 ]; then
    ok "이미 적합한 Node 설치됨: $CUR"
    need_node=0
  elif [ "$CUR_MAJOR" -ge 21 ]; then
    warn "Node $CUR 는 Big Sur 에서 불안정할 수 있어요. 20 LTS 로 교체 설치합니다."
  else
    warn "Node $CUR 는 너무 낮습니다. 20 LTS 로 설치합니다."
  fi
fi

if [ "$need_node" -eq 1 ]; then
  echo "  📥 Node 20 LTS 최신 pkg 확인 중..."
  # nodejs.org 의 latest-v20.x 디렉터리에서 .pkg 파일명을 긁어온다 (curl+grep 만으로 동작)
  PKG_NAME="$(curl -fsSL https://nodejs.org/dist/latest-v20.x/ | grep -oE 'node-v20\.[0-9]+\.[0-9]+\.pkg' | head -1 || true)"
  [ -z "$PKG_NAME" ] && die "Node 20 pkg 이름을 못 찾았습니다. 인터넷 연결을 확인하고 다시 시도하세요."
  echo "  📥 다운로드: $PKG_NAME"
  curl -fL --progress-bar -o /tmp/dopamine-node.pkg "https://nodejs.org/dist/latest-v20.x/$PKG_NAME"
  echo "  🔐 설치(sudo 암호 필요)..."
  sudo installer -pkg /tmp/dopamine-node.pkg -target /
  rm -f /tmp/dopamine-node.pkg
  hash -r
  command -v node >/dev/null 2>&1 || die "Node 설치 후에도 node 명령을 못 찾습니다. 터미널을 새로 열고 다시 실행하세요."
  ok "Node 설치됨: $(node -v)  /  npm $(npm -v)"
fi

# ── 3) cloudflared (도메인용, 선택) ─────────────────────────────
echo
bold "③ cloudflared (도메인 dopamine.me.kr 연결용 — 안 쓰면 건너뛰어도 됨)"
if command -v cloudflared >/dev/null 2>&1; then
  ok "이미 설치됨: $(command -v cloudflared)"
else
  read -r -p "  cloudflared 를 지금 설치할까요? (도메인 안 쓰면 n) [y/N] " ans || ans="n"
  if [ "${ans:-n}" = "y" ] || [ "${ans:-n}" = "Y" ]; then
    case "$ARCH" in
      arm64) CF_ASSET="cloudflared-darwin-arm64.tgz" ;;
      *)     CF_ASSET="cloudflared-darwin-amd64.tgz" ;;   # 2013 Intel
    esac
    echo "  📥 다운로드: $CF_ASSET"
    curl -fL --progress-bar -o /tmp/cloudflared.tgz \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF_ASSET"
    tar -xzf /tmp/cloudflared.tgz -C /tmp
    sudo mkdir -p /usr/local/bin
    sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
    sudo chmod +x /usr/local/bin/cloudflared
    rm -f /tmp/cloudflared.tgz
    ok "cloudflared 설치됨: $(cloudflared --version 2>/dev/null | head -1)"
    echo
    warn "터널이 아직 없다면 아래를 한 번 실행하세요(브라우저로 Cloudflare 로그인):"
    echo "      cloudflared tunnel login"
    echo "      cloudflared tunnel create pinball"
    echo "      cloudflared tunnel route dns pinball dopamine.me.kr"
    echo "   (이미 터널이 있으면 건너뛰어도 됩니다.)"
  else
    warn "cloudflared 건너뜀 — 나중에 필요하면 이 스크립트를 다시 실행하세요."
  fi
fi

# ── 4) 본 설치 스크립트로 인계 ──────────────────────────────────
echo
bold "④ 서버 설치·자동실행·자동배포·터널 등록 (setup-mac.sh 로 인계)"
echo
bash "$SCRIPT_DIR/setup-mac.sh"

echo
bold "🎉 Big Sur 부트스트랩 완료!"
echo "   • 로컬 확인:  브라우저에서 http://localhost:3000"
echo "   • 로그:       tail -f $REPO_DIR/logs/server.log"
echo "   • .env 의 ADMIN_KEY 를 채웠는지 꼭 확인하세요."
echo
