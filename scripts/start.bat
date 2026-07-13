@echo off
chcp 65001 >nul
cd /d "%~dp0.."

rem ══════════════════════════════════════════════════════
rem  DOPAMINE 서버 설정 — 원하는 값으로 수정하세요
rem ══════════════════════════════════════════════════════
set PORT=3000
rem 후원 링크 — 기본값은 운영자 카카오페이. 바꾸려면 값 수정, 끄려면 off
set DONATION_URL=https://qr.kakaopay.com/Ej8euQo2R
rem 후원자 등록용 관리자 키. 반드시 나만 아는 값으로 바꾸세요!
set ADMIN_KEY=
rem 낙하 배속(공의 속도). 비워두면 server\config.js 의 기본값(5) 사용
set TIME_SCALE=
rem ══════════════════════════════════════════════════════

echo.
echo  ██████   DOPAMINE — 인생을 건 핀볼   ██████
echo.
echo  서버 시작 중... 브라우저에서 http://localhost:%PORT% 접속
echo  (이 창을 닫으면 서버가 종료됩니다)
echo.
node server\index.js
pause
