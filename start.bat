@echo off
REM ============================================================
REM  GRANNY - Five Days to Get Out  (browser horror game)
REM  Installs deps if needed, then runs the Vite dev server.
REM ============================================================
cd /d "%~dp0"
where npm >nul 2>nul
if not %errorlevel%==0 (
  echo Node.js / npm not found. Install Node 18+ from https://nodejs.org and re-run.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Installing dependencies ^(first run^)...
  call npm install
)
echo Starting Vite dev server on http://localhost:8099 ...
start "" http://localhost:8099/
call npm run dev
