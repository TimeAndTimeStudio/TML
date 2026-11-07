@echo off
setlocal EnableExtensions
cd /d "%~dp0"
rem Owner: Time And Time Studio
rem
rem Runs the TML server and opens the launcher page in the default browser.
rem
rem   run-tml.bat           start server + open browser (reuses a running server)
rem
rem TML takes no command-line argument of its own -- this script passes none
rem through.
rem
rem Closing this console window stops the server, including one this launcher
rem started itself (the server runs attached to this window).
rem
rem Environment (inherited by the server):
rem   TML_PORT, TML_LOG_LEVEL, TML_DATA_DIR

set "PORT=%TML_PORT%"
if "%PORT%"=="" set "PORT=8653"
set "BASE=http://127.0.0.1:%PORT%"
set "HEALTH=%BASE%/api/health"

where node >nul 2>nul
if errorlevel 1 (
  echo error: node not found on PATH - install Node.js 18.17 or newer first
  exit /b 1
)

call :health
if not errorlevel 1 goto :reuse

echo Starting the TML server on %BASE% ...
start "" /B node "%~dp0src\index.js"

set /a tries=0
:wait
call :health
if not errorlevel 1 goto :open
set /a tries+=1
if %tries% LSS 30 (
  timeout /t 0.5 /nobreak >nul
  goto :wait
)
echo error: the TML server did not answer on %BASE%
exit /b 1

:reuse
echo TML server already running on %BASE% - reusing it.

:open
start "" "%BASE%"
exit /b 0

rem --- health check -------------------------------------------------------------
:health
node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "%HEALTH%"
