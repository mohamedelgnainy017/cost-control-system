@echo off
chcp 65001 >nul
title Cost Control System - Server
cd /d "%~dp0"
echo ==========================================================
echo   Cost Control System
echo ==========================================================
echo   Open in your browser:
echo     http://127.0.0.1:4310
echo.
echo   To share with others on the same Wi-Fi use:
echo     start-server-lan.cmd
echo.
echo   KEEP THIS WINDOW OPEN while working
echo   Closing it stops the server
echo ==========================================================
echo.
start "" "http://127.0.0.1:4310"
node src/server.js
echo.
echo ----------------------------------------------------------
echo  Server stopped. Press any key to close.
pause >nul
