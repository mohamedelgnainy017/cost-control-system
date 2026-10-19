@echo off
chcp 65001 >nul
title Cost Control System - Shared Server (LAN)
cd /d "%~dp0"
echo ==========================================================
echo   Shared mode - available to all devices on this network
echo ==========================================================
echo   This PC:
echo     http://127.0.0.1:4310
echo.
echo   Other devices (share this address with them):
for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress"') do echo     http://%%a:4310
echo.
echo   Notes:
echo     - Other devices must be on the same Wi-Fi
echo     - Allow access if Windows asks (Private networks)
echo     - Change the admin password after first login
echo ==========================================================
echo.
set HOST=0.0.0.0
node src/server.js
echo.
echo ----------------------------------------------------------
echo  Server stopped. Press any key to close.
pause >nul
