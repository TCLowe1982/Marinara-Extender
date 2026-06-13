# Marinara Extender
# Copyright (C) 2026 TC Lowe
# Licensed under AGPL-3.0-only. See LICENSE.

# Marinara Extender - Startup Script
# Starts Ollama and the Memory Extender sidecar, then shows live progress
# until both services are ready.

$ErrorActionPreference = "SilentlyContinue"
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$sidecarDir = Join-Path $scriptDir "memory-extender"
$OLLAMA_URL   = "http://127.0.0.1:11434"
$SIDECAR_URL  = "http://127.0.0.1:3001"
$SIDECAR_PORT = 3001
$TIMEOUT_SEC  = 90
# Default local model — must match the sidecar default (llm-config.ts).
$MODEL        = "dolphin3:8b"
$script:SidecarProc = $null
# How to launch the sidecar: "start" runs the built output (node dist); falls
# back to "run dev" (tsx) only if the build fails.
$script:RunCmd = "start"
# Opt-in auto-start: a launcher dropped in the user's Startup folder.
$startupDir    = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$autostartFile = Join-Path $startupDir "Marinara Extender.cmd"

# ── Helpers ───────────────────────────────────────────────────────────────────

function Test-Ollama {
    try { ((Invoke-WebRequest -Uri $OLLAMA_URL -TimeoutSec 2 -UseBasicParsing).StatusCode) -lt 300 }
    catch { $false }
}

function Get-OllamaExe {
    $exe = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:PROGRAMFILES\Ollama\ollama.exe"
    ) | Where-Object { Test-Path $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
    if (-not $exe) { $exe = "ollama" }
    return $exe
}

function Test-Model {
    try {
        $tags = Invoke-RestMethod -Uri "$OLLAMA_URL/api/tags" -TimeoutSec 5
        return (@($tags.models | Where-Object { $_.name -eq $MODEL -or $_.name -like "$MODEL*" }).Count -gt 0)
    } catch { return $false }
}

function Initialize-Model {
    if (Test-Model) {
        Write-Host "  [OK] Local model $MODEL is available" -ForegroundColor Green
        return
    }
    Write-Host ""
    Write-Host "  [!!] Local model '$MODEL' is not pulled yet." -ForegroundColor Yellow
    Write-Host "       It powers memory analysis and imports (a few GB download)." -ForegroundColor DarkGray
    Write-Host -NoNewline "       Pull it now? [Y/n] " -ForegroundColor Cyan
    $k = [Console]::ReadKey($true)
    Write-Host $k.KeyChar
    if ($k.KeyChar -eq 'n' -or $k.KeyChar -eq 'N') {
        Write-Host "  Skipped. Pull it later with:  ollama pull $MODEL" -ForegroundColor DarkGray
        return
    }
    Write-Host "  [..] Pulling $MODEL (this can take a while)..." -ForegroundColor Yellow
    & (Get-OllamaExe) pull $MODEL
    if (Test-Model) {
        Write-Host "  [OK] $MODEL pulled and ready" -ForegroundColor Green
    } else {
        Write-Host "  [!!] Pull did not complete. Retry later with:  ollama pull $MODEL" -ForegroundColor Red
    }
}

function Test-Sidecar {
    try { ((Invoke-WebRequest -Uri "$SIDECAR_URL/api/health" -TimeoutSec 6 -UseBasicParsing).StatusCode) -lt 300 }
    catch { $false }
}

function Start-Sidecar {
    # Port guard: if something already owns 3001, do NOT spawn a second npm
    # window. An unguarded launch races the running instance, loses the bind
    # with EADDRINUSE, and the cmd window snaps shut a beat later — which reads
    # as "the extender keeps closing" when two launchers (or two copies of this
    # script) are open at once. The running server is fine; just attach to it.
    $busy = Get-NetTCPConnection -LocalPort $SIDECAR_PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($busy) {
        Write-Host "  [OK] Memory Extender already running on port $SIDECAR_PORT (PID $($busy.OwningProcess)) - using it." -ForegroundColor Green
        $script:SidecarProc = $null
        return
    }
    $script:SidecarProc = Start-Process "cmd.exe" `
        -ArgumentList "/c npm.cmd $script:RunCmd" `
        -WorkingDirectory $sidecarDir `
        -WindowStyle Normal -PassThru
}

function Update-SidecarBuild {
    # Build the compiled output when dist is missing or older than src.
    # Returns $true if a usable dist exists afterward.
    $dist = Join-Path $sidecarDir "dist\index.js"
    $srcDir = Join-Path $sidecarDir "src"
    $needBuild = $true
    if (Test-Path $dist) {
        $distTime = (Get-Item $dist).LastWriteTime
        $newest = Get-ChildItem $srcDir -Recurse -Filter *.ts -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($newest -and $newest.LastWriteTime -le $distTime) { $needBuild = $false }
    }
    if (-not $needBuild) {
        Write-Host "  [OK] Build up to date" -ForegroundColor Green
        return $true
    }
    Write-Host "  [..] Building Memory Extender..." -ForegroundColor Yellow
    Push-Location $sidecarDir
    & npm.cmd run build
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -eq 0 -and (Test-Path $dist)) {
        Write-Host "  [OK] Build complete" -ForegroundColor Green
        return $true
    }
    Write-Host "  [!!] Build failed (see output above)." -ForegroundColor Red
    return $false
}

function Stop-Sidecar {
    # Kill the process tree we launched (cmd -> npm -> node), if we have it.
    if ($script:SidecarProc -and -not $script:SidecarProc.HasExited) {
        & cmd /c "taskkill /F /T /PID $($script:SidecarProc.Id) >nul 2>&1"
    }
    # Also kill whatever still holds the port (covers a server we didn't launch).
    try {
        Get-NetTCPConnection -LocalPort $SIDECAR_PORT -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object { & cmd /c "taskkill /F /T /PID $_ >nul 2>&1" }
    } catch {}
    $script:SidecarProc = $null
}

function Restart-Sidecar {
    Write-Host "  [..] Stopping Memory Extender..." -ForegroundColor Yellow
    Stop-Sidecar
    Start-Sleep -Milliseconds 800
    # Rebuild so a restart picks up code changes (e.g. after a git pull).
    if (Update-SidecarBuild) { $script:RunCmd = "start" } else { $script:RunCmd = "run dev" }
    Write-Host "  [..] Starting Memory Extender..." -ForegroundColor Yellow
    Start-Sidecar
    Write-Host -NoNewline "  [..] Waiting for it to come back "
    $waited = 0
    while (-not (Test-Sidecar) -and $waited -lt 30) {
        Start-Sleep -Seconds 1
        $waited++
        Write-Host -NoNewline "."
    }
    Write-Host ""
    if (Test-Sidecar) {
        Write-Host "  [OK] Memory Extender restarted and healthy." -ForegroundColor Green
    } else {
        Write-Host "  [!!] Did not come back within 30s. Check the npm window for errors." -ForegroundColor Red
    }
}

function Get-Bar($current, $total, $width = 34) {
    $filled = [int]([Math]::Min([double]$current / $total, 1.0) * $width)
    $empty  = $width - $filled
    ("[" + ("#" * $filled) + ("-" * $empty) + "]")
}

$spinFrames = @("|", "/", "-", "\")

# ── Header ────────────────────────────────────────────────────────────────────

Clear-Host
Write-Host ""
Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
Write-Host "  |      Marinara Extender -- Startup        |" -ForegroundColor Cyan
Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
Write-Host ""

# ── Node.js preflight ─────────────────────────────────────────────────────────

$nodeOk = $false
try {
    $nodeVer = (& node --version) 2>$null
    if ($nodeVer -match '^v(\d+)\.') { if ([int]$Matches[1] -ge 20) { $nodeOk = $true } }
} catch {}
if (-not $nodeOk) {
    Write-Host "  [!!] Node.js 20 or newer is required and was not found on PATH." -ForegroundColor Red
    Write-Host "       Install it from https://nodejs.org/ then run this again." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host -NoNewline "  Press any key to exit..." -ForegroundColor Cyan
    [Console]::ReadKey($true) | Out-Null
    exit 1
}

# ── Install deps if needed ────────────────────────────────────────────────────

$nodeModules = Join-Path $sidecarDir "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host "  Installing dependencies (first run)..." -ForegroundColor Yellow
    Push-Location $sidecarDir
    & npm.cmd install --silent
    Pop-Location
    Write-Host "  [OK] Dependencies installed" -ForegroundColor Green
    Write-Host ""
}

# ── Build (run the compiled output, not the dev watcher) ──────────────────────

if (-not (Update-SidecarBuild)) {
    Write-Host "  Falling back to dev mode (tsx) for this run." -ForegroundColor DarkGray
    $script:RunCmd = "run dev"
}
Write-Host ""

# ── Check for Ollama update in progress ──────────────────────────────────────

$ollamaUpdate = Get-Process -Name "OllamaSetup" -ErrorAction SilentlyContinue
if ($ollamaUpdate) {
    Write-Host "  [..] Ollama is updating - waiting for it to finish..." -ForegroundColor Yellow
    $waited = 0
    while ((Get-Process -Name "OllamaSetup" -ErrorAction SilentlyContinue) -and $waited -lt 120) {
        Start-Sleep -Seconds 3
        $waited += 3
        Write-Host -NoNewline "`r  [..] Ollama updating... ${waited}s elapsed  "
    }
    Write-Host ""
    if ($waited -ge 120) {
        Write-Host "  [!!] Ollama update timed out. It may still be running." -ForegroundColor Yellow
    } else {
        Write-Host "  [OK] Ollama update finished" -ForegroundColor Green
        Start-Sleep -Seconds 2  # give it a moment to settle
    }
}

# ── Start Ollama ──────────────────────────────────────────────────────────────

if (Test-Ollama) {
    Write-Host "  [OK] Ollama is already running" -ForegroundColor Green
} else {
    Write-Host "  [..] Starting Ollama..." -ForegroundColor Yellow
    Start-Process (Get-OllamaExe) -WindowStyle Minimized
}

# ── Start Memory Extender ─────────────────────────────────────────────────────

if (Test-Sidecar) {
    Write-Host "  [OK] Memory Extender is already running" -ForegroundColor Green
} else {
    Write-Host "  [..] Starting Memory Extender..." -ForegroundColor Yellow
    Start-Sidecar
}

Write-Host ""

# ── Live status display ───────────────────────────────────────────────────────

$statusRow = [Console]::CursorTop
Write-Host "  Ollama          [?] ..."
Write-Host "  Memory Extender [?] ..."
Write-Host ""
$barRow = [Console]::CursorTop
Write-Host "  $(Get-Bar 0 $TIMEOUT_SEC) 0s / ${TIMEOUT_SEC}s"
Write-Host ""

$startTime  = Get-Date
$ollamaOk   = $false
$sidecarOk  = $false
$frameIndex = 0

while ($true) {
    $elapsed = [int]((Get-Date) - $startTime).TotalSeconds
    $spin    = $spinFrames[$frameIndex % $spinFrames.Count]
    $frameIndex++

    if (-not $ollamaOk)  { $ollamaOk  = Test-Ollama  }
    if (-not $sidecarOk) { $sidecarOk = Test-Sidecar }

    # Ollama line
    [Console]::SetCursorPosition(0, $statusRow)
    if ($ollamaOk) {
        Write-Host "  Ollama          [OK] Ready        " -ForegroundColor Green
    } else {
        Write-Host "  Ollama          [$spin]  Starting... " -ForegroundColor Yellow
    }

    # Sidecar line
    [Console]::SetCursorPosition(0, $statusRow + 1)
    if ($sidecarOk) {
        Write-Host "  Memory Extender [OK] Ready        " -ForegroundColor Green
    } else {
        Write-Host "  Memory Extender [$spin]  Starting... " -ForegroundColor Yellow
    }

    # Progress bar
    [Console]::SetCursorPosition(0, $barRow)
    Write-Host "  $(Get-Bar $elapsed $TIMEOUT_SEC) ${elapsed}s / ${TIMEOUT_SEC}s  " -ForegroundColor DarkGray

    if ($ollamaOk -and $sidecarOk) {
        [Console]::SetCursorPosition(0, $barRow + 2)
        Write-Host "  [OK] All services ready -- open Marinara in your browser." -ForegroundColor Green
        Write-Host ""
        break
    }

    if ($elapsed -ge $TIMEOUT_SEC) {
        [Console]::SetCursorPosition(0, $barRow + 2)
        if (-not $ollamaOk)  { Write-Host "  [!!] Ollama did not respond. Is it installed?" -ForegroundColor Red }
        if (-not $sidecarOk) { Write-Host "  [!!] Memory Extender did not start. Check the npm window for errors." -ForegroundColor Red }
        Write-Host ""
        break
    }

    Start-Sleep -Milliseconds 300
}

# ── Ensure the local model is pulled ──────────────────────────────────────────

if ($ollamaOk) { Initialize-Model; Write-Host "" }

# ── Command console ─────────────────────────────────────────────────────────

$autoState = if (Test-Path $autostartFile) { "ON" } else { "off" }
Write-Host "  Commands:  [R] Restart server   [A] Auto-start on login ($autoState)   [Q] Quit (services keep running)" -ForegroundColor Cyan
Write-Host ""

while ($true) {
    Write-Host -NoNewline "  extender> " -ForegroundColor Cyan
    $key = [Console]::ReadKey($true)
    $cmd = $key.KeyChar.ToString().ToLower()
    Write-Host $cmd
    if ($cmd -eq 'q') {
        break
    } elseif ($cmd -eq 'r') {
        Restart-Sidecar
    } elseif ($cmd -eq 'a') {
        if (Test-Path $autostartFile) {
            Remove-Item $autostartFile -Force -ErrorAction SilentlyContinue
            Write-Host "  [OK] Auto-start on login DISABLED." -ForegroundColor Green
        } else {
            try {
                if (-not (Test-Path $startupDir)) { New-Item -ItemType Directory -Force -Path $startupDir | Out-Null }
                $launcher = "@echo off`r`nstart `"`" /min powershell -ExecutionPolicy Bypass -NoExit -File `"$(Join-Path $scriptDir 'start.ps1')`""
                Set-Content -Path $autostartFile -Value $launcher -Encoding ASCII
                Write-Host "  [OK] Auto-start on login ENABLED (launches minimized). Press A again to disable." -ForegroundColor Green
            } catch {
                Write-Host "  [!!] Could not write the startup launcher: $_" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "  Unknown command. [R] restart  [A] auto-start  [Q] quit." -ForegroundColor DarkGray
    }
}
