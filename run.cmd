@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 (
  echo Could not open the application folder.
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 18)) process.exit(1);" >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.18 or later is required. Install Node.js, then open a new terminal.
  goto :failed
)

"%SystemRoot%\System32\where.exe" npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js, then open a new terminal.
  goto :failed
)

if not exist "node_modules\vite\bin\vite.js" (
  echo Dependencies are missing. Run powershell -ExecutionPolicy Bypass -File setup.ps1 first.
  goto :failed
)
echo Building Business Analytics Studio from the current source.
call npm.cmd run build
set "result=%errorlevel%"
if not "%result%"=="0" (
  echo Build failed. The application was not started. Fix the error above and run run.cmd again.
  goto :finish
)
if not exist "dist\index.html" (
  echo Build output dist\index.html is missing. The application was not started.
  goto :failed
)

echo Starting Business Analytics Studio. Opening the app in your default web browser.
echo If the port is in use, Vite will report it and open the next available port.
echo Project data is shared across ports in this application's .bas-local folder.
echo For old browser-only data, open the updated app once at its original port to migrate it.
echo Press Ctrl+C to stop.
call npm.cmd run preview -- --strictPort false --open %*
set "result=%errorlevel%"
if not "%result%"=="0" echo Startup failed. Read the error above, fix the cause and run run.cmd again.
goto :finish

:failed
set "result=1"

:finish
popd
endlocal & exit /b %result%
