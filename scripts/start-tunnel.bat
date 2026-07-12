@echo off
chcp 65001 >nul

rem ══════════════════════════════════════════════════════
rem  Cloudflare Tunnel 실행 (도메인 연결용)
rem  사전 준비 (최초 1회, README '배포하기' 참고):
rem    winget install Cloudflare.cloudflared
rem    cloudflared tunnel login
rem    cloudflared tunnel create pinball
rem    cloudflared tunnel route dns pinball game.내도메인.com
rem ══════════════════════════════════════════════════════

echo  터널 연결 중... https://내도메인 으로 접속 가능해집니다
echo  (이 창을 닫으면 외부 접속이 끊깁니다. 서버 창은 따로 켜두세요)
echo.
cloudflared tunnel run --url http://localhost:3000 pinball
pause
