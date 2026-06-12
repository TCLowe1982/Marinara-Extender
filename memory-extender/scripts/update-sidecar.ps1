# Marinara Extender
# Copyright (C) 2026 TC Lowe
# Licensed under AGPL-3.0-only. See LICENSE.
#
# One-click updater (MarinaraExtender-uo4). Invoked by the panel's Update
# button (via POST /api/update) or by double-clicking
# Marinara_Extender_Update.bat — never requires a terminal. Runs in a VISIBLE
# console so the user can watch progress; everything also logs to
# memory-extender\logs\update.log.
#
# Steps: stop the running sidecar -> git pull --ff-only -> npm install ->
# npm run build -> ensure the embedding model is pulled (best effort) ->
# relaunch via Marinara_Extender_Start.bat.

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$pkgRoot  = Resolve-Path (Join-Path $PSScriptRoot "..")        # memory-extender
$repoRoot = Resolve-Path (Join-Path $pkgRoot "..")             # repo root
$logDir   = Join-Path $pkgRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory $logDir | Out-Null }
$log = Join-Path $logDir "update.log"

function Step([string]$msg) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
  Write-Host $line -ForegroundColor Cyan
  Add-Content -Path $log -Value $line -Encoding UTF8
}
function Fail([string]$msg) {
  Write-Host ""
  Write-Host "UPDATE FAILED: $msg" -ForegroundColor Red
  Write-Host "Nothing was broken - the previous version is still on disk." -ForegroundColor Yellow
  Write-Host "Details in memory-extender\logs\update.log"
  Add-Content -Path $log -Value "FAILED: $msg" -Encoding UTF8
  pause
  exit 1
}

Add-Content -Path $log -Value ("===== update started " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " =====") -Encoding UTF8
Write-Host "Marinara Extender updater" -ForegroundColor Green
Write-Host ""

# 1. Stop the running sidecar (it relaunches at the end).
Step "Stopping the memory server..."
$busy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  try { Stop-Process -Id $busy.OwningProcess -Confirm:$false -ErrorAction Stop; Start-Sleep -Seconds 1 } catch {}
}

# 2. Pull the update. --ff-only so a locally-modified checkout is never merged
#    over silently; that case fails loudly with advice instead.
Step "Downloading the update (git pull)..."
$pull = git -C $repoRoot pull --ff-only 2>&1 | Out-String
Add-Content -Path $log -Value $pull -Encoding UTF8
Write-Host $pull
if ($LASTEXITCODE -ne 0) {
  Fail "git pull did not complete. If you have local changes, commit or stash them; if offline, try again later."
}

# 3. Dependencies + build.
Step "Installing dependencies (npm install)..."
Push-Location $pkgRoot
cmd /c "npm install --no-audit --no-fund 2>&1" | Tee-Object -Variable npmOut | Out-Host
Add-Content -Path $log -Value ($npmOut -join "`n") -Encoding UTF8
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install failed." }

Step "Building (npm run build)..."
cmd /c "npm run build 2>&1" | Tee-Object -Variable buildOut | Out-Host
Add-Content -Path $log -Value ($buildOut -join "`n") -Encoding UTF8
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "build failed." }
Pop-Location

# 4. Embedding model (best effort — everything degrades gracefully without it).
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) {
  $have = (& ollama list 2>$null | Out-String)
  if ($have -notmatch "nomic-embed-text") {
    Step "Pulling the embedding model (nomic-embed-text, one-time ~274MB)..."
    & ollama pull nomic-embed-text
  }
} else {
  Step "Ollama not found on PATH - skipping embedding model (semantic features stay off)."
}

# 5. Relaunch.
Step "Starting the memory server..."
Start-Process (Join-Path $repoRoot "Marinara_Extender_Start.bat")
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "Update complete. Reload your Marinara browser tab to finish." -ForegroundColor Green
Add-Content -Path $log -Value "update complete" -Encoding UTF8
Start-Sleep -Seconds 8
