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
if not exist "dist\index.html" (
  echo The app is not built. Run npm.cmd run build first.
  goto :failed
)
node "scripts\check-build.mjs" "%CD%"
if errorlevel 1 (
  echo The app was not rebuilt after the last change, so it would show an older version. Run npm.cmd run build, then run.cmd again.
  goto :failed
)

echo Starting Business Analytics Studio. Open the URL printed below.
echo Press Ctrl+C to stop.
call npm.cmd run preview -- %*
set "result=%errorlevel%"
if not "%result%"=="0" echo Startup failed. Read the error above, fix the cause and run run.cmd again.
goto :finish

:failed
set "result=1"

:finish
popd
endlocal & exit /b %result%
