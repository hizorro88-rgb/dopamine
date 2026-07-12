@echo off
chcp 65001 >nul
cd /d "%~dp0.."

rem ══════════════════════════════════════════════════════
rem  DOPAMINE 서버 설정 — 원하는 값으로 수정하세요
rem ══════════════════════════════════════════════════════
set PORT=3000
rem 후원 링크 (토스아이디 등). 비워두면 후원 버튼이 숨겨집니다.
set DONATION_URL=
rem 후원자 등록용 관리자 키. 반드시 나만 아는 값으로 바꾸세요!
set ADMIN_KEY=
rem ══════════════════════════════════════════════════════

echo.
echo  ██████   DOPAMINE — 인생을 건 핀볼   ██████
echo.
echo  서버 시작 중... 브라우저에서 http://localhost:%PORT% 접속
echo  (이 창을 닫으면 서버가 종료됩니다)
echo.
node server\index.js
pause
