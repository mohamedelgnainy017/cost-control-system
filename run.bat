@echo off
chcp 65001 >nul
title نظام متابعة الاستهلاك والتكاليف
cd /d "%~dp0"

echo =================================================
echo   نظام متابعة الاستهلاك والتكاليف
echo   الرابط: http://127.0.0.1:4310
echo   اضغط Ctrl+C لإيقاف الخادم
echo =================================================

rem فتح النافذة كتطبيق (Edge App) بعد ثانيتين — وإلا المتصفح العادي
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Sleep -Seconds 2; $edge = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Microsoft\Edge\Application\msedge.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1; ^
   if ($edge) { Start-Process $edge -ArgumentList '--app=http://127.0.0.1:4310' } else { Start-Process 'http://127.0.0.1:4310' }"

node src\server.js
pause
