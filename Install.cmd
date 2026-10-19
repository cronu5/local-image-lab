@echo off
setlocal
cd /d "%~dp0"
title Local Image Lab - Install
if not exist "%~dp0installer\install.ps1" (
  echo The installer files are missing.
  echo If you opened Install.cmd from inside the ZIP file, close this window,
  echo right-click the ZIP, choose "Extract All", and run Install.cmd from the extracted folder.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
set "INSTALL_EXIT=%errorlevel%"
echo.
echo Press any key to close this window.
pause >nul
exit /b %INSTALL_EXIT%
