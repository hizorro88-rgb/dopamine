@echo off
chcp 65001 >nul
cd /d "%~dp0.."

rem ══════════════════════════════════════════════════════
rem  DOPAMINE 자동 배포 모드
rem  - git 에 새 코드가 올라오면 자동으로 받아서 서버를 재시작합니다
rem  - 설정(비밀키 등)은 .env 파일에서 관리하세요 (.env.example 를 복사)
rem  - 이 창을 닫으면 서버가 멈춥니다
rem ══════════════════════════════════════════════════════

echo.
echo  ██████   DOPAMINE 자동 배포 모드   ██████
echo.
echo  git 에 새 커밋이 올라오면 자동으로 pull 하고 서버를 재시작합니다.
echo  설정은 .env 파일에서 관리하세요. (이 창을 닫으면 서버가 종료됩니다)
echo.

node scripts\autodeploy.js
pause
