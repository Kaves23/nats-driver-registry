@echo off
title NATS Race Day Server - LOCAL MODE
color 0E
echo ============================================================
echo   NATS RACE DAY SERVER - LOCAL + SYNC MODE
echo ============================================================
echo.
echo   Database : LOCAL PostgreSQL (this laptop)
echo   Sync     : Cloud push every 30s / pull every 60s
echo   Port     : http://localhost:3000
echo.
echo   Staff connect to: http://192.168.0.100:3000
echo   (or rokthenats.co.za if DNS is configured on router)
echo.
echo   Press Ctrl+C to stop the server
echo ============================================================
echo.

:: Change to the folder this bat file lives in (works from Dropbox or any path)
cd /d "%~dp0"

:: Kill any existing node process on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /F /PID %%a 2>nul
timeout /t 1 /nobreak >nul

node -r dotenv/config server.js dotenv_config_path=.env.raceday
pause
