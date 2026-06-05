@echo off
REM Marinara Extender
REM Copyright (C) 2026 TC Lowe
REM Licensed under AGPL-3.0-only. See LICENSE.
echo Starting Memory Extender...
start "Memory Extender" /d "%~dp0memory-extender" cmd /k "npm run dev"
echo Memory Extender started. Close the "Memory Extender" window to stop it.
