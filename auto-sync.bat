@echo off
REM ===========================================================================
REM  BMS Appointment - auto sync loop (no browser, no button click)
REM  Runs sync-cli.js every INTERVAL_MIN minutes. Makes sure server.js (the
REM  POST target that owns the central-DB connection) is running first.
REM  Edit PORT / INTERVAL_MIN below if needed. Ctrl+C to stop.
REM ===========================================================================
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

set "PORT=8780"
set "INTERVAL_MIN=1"
set "LOG=sync.log"
set /a INTERVAL_SEC=%INTERVAL_MIN%*60

if not exist "sync.config.json" (
  echo [!] not found: sync.config.json
  echo     copy sync.config.example.json to sync.config.json and set your BMS Session ID
  pause
  exit /b 1
)

REM --- make sure server.js dependency (pg) is installed ---
if not exist "node_modules\pg" (
  echo Installing pg ...
  call npm install
)

REM --- make sure server.js is running (it owns .env + the DB write) ---
curl -s -o nul "http://127.0.0.1:%PORT%/api/online/ping"
if errorlevel 1 (
  echo Starting server.js on port %PORT% ...
  start "BMS Appointment server" /min cmd /c "node server.js"
  timeout /t 4 /nobreak >nul
)

echo ============================================
echo   BMS Appointment - AUTO SYNC
echo   every %INTERVAL_MIN% min  ^|  log: %LOG%
echo   Ctrl+C to stop
echo ============================================

:loop
node sync-cli.js
echo --- next run in %INTERVAL_MIN% min --- (Ctrl+C to stop)
timeout /t %INTERVAL_SEC% /nobreak >nul
goto loop
