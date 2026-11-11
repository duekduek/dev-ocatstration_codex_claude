@echo off
chcp 65001 >nul
title devagent GUI
rem 사용법: devagent-gui.cmd [프로젝트 폴더]  (생략하면 마지막으로 연 폴더)
set "DEVAGENT=%~dp0..\bin\devagent.js"
set "PROJECT=%~1"

rem Docker가 꺼져 있으면 켜고 엔진이 준비될 때까지 대기
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop을 시작합니다...
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  for /l %%i in (1,1,90) do (
    timeout /t 2 /nobreak >nul
    docker info >nul 2>&1 && goto docker_ready
  )
  echo Docker가 3분 안에 준비되지 않았습니다. Docker Desktop을 확인한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
:docker_ready
echo Docker 준비 완료

if "%PROJECT%"=="" (
  node "%DEVAGENT%" gui
) else (
  node "%DEVAGENT%" gui --dir "%PROJECT%"
)
echo.
echo GUI 서버가 종료되었습니다.
pause
