@echo off
echo Starting Memory Extender...
cd /d "%~dp0memory-extender"
start "Memory Extender" cmd /k "npm run dev"
echo Memory Extender started. Close the "Memory Extender" window to stop it.
