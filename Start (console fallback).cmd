@echo off
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo Local Image Lab is not installed yet. Double-click Install.cmd in this folder first.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0app\server.mjs" --open
pause
