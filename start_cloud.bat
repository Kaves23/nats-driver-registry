@echo off
title NATS Server - CLOUD MODE
color 0A
echo ============================================================
echo   NATS SERVER - CLOUD MODE (normal production)
echo ============================================================
echo.
echo   Database : PlanetScale cloud
echo   Port     : http://localhost:3000
echo.
echo   Press Ctrl+C to stop the server
echo ============================================================
echo.

:: Change to the folder this bat file lives in (works from Dropbox or any path)
cd /d "%~dp0"

:: Kill any existing node process on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /F /PID %%a 2>nul
timeout /t 1 /nobreak >nul

node -r dotenv/config server.js dotenv_config_path=.env
pause
