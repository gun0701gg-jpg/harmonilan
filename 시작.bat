@echo off
chcp 65001 > nul
title 하모닐란 재고 관리 서버
cd /d "%~dp0"

echo.
echo  ================================================
echo   하모닐란 재고 관리 시스템 시작 중...
echo  ================================================
echo.

:: node 설치 확인
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [오류] Node.js가 설치되어 있지 않습니다.
    echo.
    echo  아래 주소에서 Node.js LTS 버전을 설치하세요:
    echo  https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: 패키지 설치 확인
if not exist "node_modules" (
    echo  처음 실행 - 필요한 패키지를 설치합니다...
    npm install
    echo.
)

:: IP 주소 표시
echo  ================================================
echo   아래 주소로 접속하세요:
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set ip=%%a
    setlocal enabledelayedexpansion
    set ip=!ip: =!
    echo    모바일/PC:  http://!ip!:3000
    endlocal
)
echo    이 PC:       http://localhost:3000
echo  ================================================
echo.
echo  서버를 종료하려면 이 창을 닫으세요.
echo.

node server.js
pause
