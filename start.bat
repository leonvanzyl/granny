@echo off
REM ============================================================
REM  GRANNY - Five Days to Get Out  (browser horror game)
REM  Serves the folder over HTTP and opens it in your browser.
REM ============================================================
cd /d "%~dp0"
echo Starting local server on http://localhost:8099 ...
start "" http://localhost:8099/
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8099
) else (
  echo Python not found - trying npx serve...
  npx --yes serve -l 8099 .
)
