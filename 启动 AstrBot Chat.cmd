@echo off
chcp 65001 >nul
title AstrBot Chat Launcher
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-pocket.ps1"
if errorlevel 1 (
  echo.
  echo Failed to start. See astrbot-chat\logs\launcher.log
  pause
)
