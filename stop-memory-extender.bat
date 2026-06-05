@echo off
REM Marinara Extender
REM Copyright (C) 2026 TC Lowe
REM Licensed under AGPL-3.0-only. See LICENSE.
echo Stopping Memory Extender on port 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001 "') do (
    echo Killing PID %%a
    taskkill /PID %%a /F >nul 2>&1
)
echo Done.
