@echo off
chcp 65001 >nul
title Stop AstrBot Chat
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-pocket.ps1"
pause
