@echo off
cd /d "%~dp0"
title Local Image Lab - Add music to a movie
rem Drag a finished movie and a song onto this file together. The original movie is not changed.
rem Optional: add a number from 0.05 to 1 to set the music volume (default 0.35).
"%~dp0runtime\node.exe" "%~dp0app\add-music.mjs" %*
pause
