@echo off
chcp 65001 >nul
cd /d "%~dp0.."

rem ══════════════════════════════════════════════════════════════
rem  DOPAMINE 올인원 실행 (윈도우) — 서버 + Cloudflare Tunnel
rem ══════════════════════════════════════════════════════════════
rem  · 서버 하나에 핀볼과 악어 룰렛이 함께 들어있습니다 (별도 실행 불필요)
rem      /            게임 선택 메인페이지
rem      /pinball     핀볼
rem      /crocodile   악어 룰렛
rem  · 서버는 자동배포 모드로 돕니다 — git 에 새 코드가 올라오면
rem    자동으로 받아서 재시작 (설정은 .env 파일에서, .env.example 복사)
rem  · 사전 준비(최초 1회): Node 18+, git,
rem      cloudflared:  winget install Cloudflare.cloudflared
rem                    cloudflared tunnel login
rem                    cloudflared tunnel create pinball
rem                    cloudflared tunnel route dns pinball dopamine.me.kr
rem ══════════════════════════════════════════════════════════════

echo.
echo  ██████   DOPAMINE 올인원 실행 (서버 + 터널)   ██████
echo.

rem .env 없으면 예시에서 복사 (ADMIN_KEY 등은 직접 채우세요)
if not exist .env (
  if exist .env.example (
    copy /y .env.example .env >nul
    echo  [알림] .env 를 새로 만들었습니다. ADMIN_KEY 등을 채워주세요: %cd%\.env
  )
)

rem 의존성 설치 (최초 1회)
if not exist node_modules (
  echo  의존성 설치 중... ^(최초 1회^)
  call npm install
)

rem ── 포트 3000 이 이미 사용 중이면(이전 서버가 떠 있으면) 정리하고 시작 ──
set BUSYPID=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do set BUSYPID=%%p
if defined BUSYPID (
  echo  [경고] 포트 3000 이 이미 사용 중입니다 ^(PID %BUSYPID%^) — 이전 서버가 떠 있는 것 같습니다.
  choice /c YN /m "  이전 서버를 종료하고 계속할까요"
  if errorlevel 2 (
    echo  취소했습니다. 이전 서버 창을 직접 닫은 뒤 다시 실행하세요.
    pause
    exit /b 1
  )
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do taskkill /f /pid %%p >nul 2>nul
  timeout /t 2 /nobreak >nul
  rem 정리됐는지 재확인 — 관리자 권한 프로세스는 일반 권한으로 못 죽인다
  set STILLBUSY=
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do set STILLBUSY=%%p
  if defined STILLBUSY (
    echo.
    echo  [실패] 이전 서버를 종료하지 못했습니다 ^(액세스 거부 — 관리자 권한 프로세스^).
    echo  해결: 이 파일^(start-all.bat^)을 우클릭 - "관리자 권한으로 실행" 하거나,
    echo        관리자 터미널에서  taskkill /f /im node.exe  실행 후 다시 시작하세요.
    echo.
    pause
    exit /b 1
  )
  echo  이전 서버를 종료했습니다.
)

rem 1) 서버 (자동배포 모드) — 새 창에서 실행
start "DOPAMINE 서버" cmd /k "chcp 65001 >nul & node scripts\autodeploy.js"

rem 2) Cloudflare Tunnel — cloudflared 가 설치돼 있으면 새 창에서 실행
where cloudflared >nul 2>nul
if %errorlevel%==0 (
  start "DOPAMINE 터널" cmd /k "chcp 65001 >nul & cloudflared tunnel run --url http://localhost:3000 pinball"
) else (
  echo  [알림] cloudflared 가 없어 터널은 건너뜁니다. 도메인 연결하려면:
  echo         winget install Cloudflare.cloudflared   후 이 스크립트를 다시 실행
)

echo.
echo  ─────────────────────────────────────────────
echo   메인페이지:  http://localhost:3000/
echo   핀볼:        http://localhost:3000/pinball
echo   악어 룰렛:   http://localhost:3000/crocodile
echo   도메인:      https://dopamine.me.kr/
echo  ─────────────────────────────────────────────
echo   서버/터널은 각각 새 창에서 돌아갑니다.
echo   그 창들을 닫으면 해당 기능이 꺼집니다. 이 창은 닫아도 됩니다.
echo.
pause
