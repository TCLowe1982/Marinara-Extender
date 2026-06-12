@echo off
rem Marinara Extender sidecar launcher.
rem Opens a VISIBLE console (live logs to watch/copy) and tees everything to
rem memory-extender\logs\sidecar.log so the log survives even if the window
rem closes or the machine crashes. Safe to re-run: refuses if port 3001 is
rem already serving.

cd /d "%~dp0memory-extender"
if not exist logs mkdir logs

powershell -NoLogo -ExecutionPolicy Bypass -Command ^
  "$busy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue;" ^
  "if ($busy) { Write-Host 'Sidecar already running on port 3001 (PID' $busy.OwningProcess ') - close it first.' -ForegroundColor Yellow; pause; exit 1 }" ^
  "Add-Content -Path logs\sidecar.log -Value ('===== session start ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====') -Encoding UTF8;" ^
  "node dist/index.js 2>&1 | ForEach-Object { $_; Add-Content -Path logs\sidecar.log -Value $_ -Encoding UTF8 }"

echo.
echo Sidecar exited. Log saved to memory-extender\logs\sidecar.log
pause
