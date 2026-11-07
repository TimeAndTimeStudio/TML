@echo off
setlocal
rem Owner: Time And Time Studio
rem Creates the "TML" desktop shortcut (run install-shortcut.ps1).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shortcut.ps1"
if errorlevel 1 (
  echo error: install-shortcut.ps1 failed
  exit /b 1
)
endlocal
