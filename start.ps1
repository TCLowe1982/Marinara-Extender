# Marinara Extender - Startup Script
# Starts Ollama and the Memory Extender sidecar, then shows live progress
# until both services are ready.

$ErrorActionPreference = "SilentlyContinue"
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$sidecarDir = Join-Path $scriptDir "memory-extender"
$OLLAMA_URL  = "http://127.0.0.1:11434"
$SIDECAR_URL = "http://127.0.0.1:3001"
$TIMEOUT_SEC = 90

# ── Helpers ───────────────────────────────────────────────────────────────────

function Test-Ollama {
    try { ((Invoke-WebRequest -Uri $OLLAMA_URL -TimeoutSec 2 -UseBasicParsing).StatusCode) -lt 300 }
    catch { $false }
}

function Test-Sidecar {
    try { ((Invoke-WebRequest -Uri "$SIDECAR_URL/api/health" -TimeoutSec 6 -UseBasicParsing).StatusCode) -lt 300 }
    catch { $false }
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
    $ollamaExe = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:PROGRAMFILES\Ollama\ollama.exe",
        "ollama"
    ) | Where-Object { Test-Path $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
    if (-not $ollamaExe) { $ollamaExe = "ollama" }
    Start-Process $ollamaExe -WindowStyle Minimized
}

# ── Start Memory Extender ─────────────────────────────────────────────────────

if (Test-Sidecar) {
    Write-Host "  [OK] Memory Extender is already running" -ForegroundColor Green
} else {
    Write-Host "  [..] Starting Memory Extender..." -ForegroundColor Yellow
    Start-Process "cmd.exe" `
        -ArgumentList "/c npm.cmd run dev" `
        -WorkingDirectory $sidecarDir `
        -WindowStyle Normal
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

Write-Host "  Press any key to close..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
