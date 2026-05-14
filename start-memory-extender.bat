@echo off
echo Starting Memory Extender...
start "Memory Extender" /d "%~dp0memory-extender" cmd /k "npm run dev"
echo Memory Extender started. Close the "Memory Extender" window to stop it.
