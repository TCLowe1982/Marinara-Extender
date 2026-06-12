@echo off
rem Marinara Extender sidecar launcher.
rem Opens a VISIBLE console (live logs to watch/copy) and tees everything to
rem memory-extender\logs\sidecar.log so the log survives even if the window
rem closes or the machine crashes. Safe to re-run: refuses if port 3001 is
rem already serving.
rem
rem Notes on the plumbing: stderr is merged into stdout HERE in cmd (the
rem "2>&1") — doing it inside PowerShell 5.1 wraps every console.warn line
rem from node in NativeCommandError ceremony. chcp 65001 + UTF8 console
rem encoding keep node's em-dashes from rendering as mojibake.

chcp 65001 >nul
cd /d "%~dp0memory-extender"
if not exist logs mkdir logs

powershell -NoLogo -Command "$busy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue; if ($busy) { Write-Host ('Sidecar already running on port 3001 (PID ' + $busy.OwningProcess + ') - close it first.') -ForegroundColor Yellow; exit 1 }"
if errorlevel 1 ( pause & exit /b 1 )

echo ===== session start %date% %time% =====>> logs\sidecar.log

node dist/index.js 2>&1 | powershell -NoLogo -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $input | ForEach-Object { $_; Add-Content -Path logs\sidecar.log -Value $_ -Encoding UTF8 }"

echo.
echo Sidecar exited. Log saved to memory-extender\logs\sidecar.log
pause
