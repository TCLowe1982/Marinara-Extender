# Marinara Extender
# Copyright (C) 2026 TC Lowe
# Licensed under AGPL-3.0-only. See LICENSE.
#
# Sidecar runner — invoked by Marinara_Extender_Start.bat. All launcher logic
# lives here because cmd batch parsing (carets, codepages, line endings) is a
# minefield; the .bat is one line.
#
# stderr is merged into stdout by an inner cmd /c, NOT by PowerShell — PS 5.1
# wraps native stderr lines in NativeCommandError ceremony when it does the
# merge itself. UTF-8 console output keeps node's em-dashes readable.

Set-Location (Join-Path $PSScriptRoot "..")
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$busy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  Write-Host "Sidecar already running on port 3001 (PID $($busy.OwningProcess)) - close it first." -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path logs)) { New-Item -ItemType Directory logs | Out-Null }
Add-Content -Path logs\sidecar.log -Value ("===== session start " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " =====") -Encoding UTF8

cmd /c "node dist/index.js 2>&1" | ForEach-Object {
  $_
  Add-Content -Path logs\sidecar.log -Value $_ -Encoding UTF8
}

Write-Host ""
Write-Host "Sidecar exited. Log: memory-extender\logs\sidecar.log"
