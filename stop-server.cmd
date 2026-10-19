@echo off
chcp 65001 >nul
title Cost Control - Stop Server
cd /d "%~dp0"
echo Stopping the server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":4310 .*LISTENING"') do (
  taskkill /f /pid %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul
netstat -ano | findstr /r /c:":4310 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo Server is still running - try again as administrator.
) else (
  echo Server stopped.
)
echo.
pause
