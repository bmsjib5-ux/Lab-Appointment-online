@echo off
setlocal
cd /d "%~dp0"

rem ---- Config ----
if "%PORT%"=="" set PORT=8780

rem ---- Check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org/ ^(>= 18^)
  pause
  exit /b 1
)

rem ---- Install deps (pg) if missing ----
if not exist "node_modules\pg" (
  echo [setup] Installing dependencies ^(pg^)...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
  )
)

echo.
echo ============================================
echo   BMS Appointment - Patient Appointment
echo   http://localhost:%PORT%/login.html
echo ============================================
echo.
echo Press Ctrl+C to stop the server.
echo.

rem ---- Open the browser shortly after the server starts ----
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%/login.html"

rem ---- Run server (serves the page + proxies the central online DB) ----
node server.js

endlocal
