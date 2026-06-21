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
# Embedding model — powers semantic recall (recap activation, chunk-merge).
# Default-on in the sidecar; small (~275 MB) next to the chat model.
$EMBED_MODEL  = "nomic-embed-text"
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

# Bring-your-own-backend: read MARINARA_EXTENDER_LOCAL_URL from .env so the
# launcher can tell when the user runs a non-Ollama OpenAI server (KoboldCpp,
# LM Studio, llama.cpp) and skip the Ollama-specific setup entirely.
function Get-EnvLocalUrl {
    $envPath = Join-Path $sidecarDir ".env"
    if (-not (Test-Path $envPath)) { return "" }
    $m = Select-String -Path $envPath -Pattern '^\s*MARINARA_EXTENDER_LOCAL_URL\s*=(.*)$' | Select-Object -First 1
    if (-not $m) { return "" }
    return ($m.Matches[0].Groups[1].Value).Trim()
}

function Test-LocalBackend {
    # Reachable = any HTTP answer; OpenAI servers often 404 the base path but are up.
    try { $null = Invoke-WebRequest -Uri $localUrl -TimeoutSec 2 -UseBasicParsing; return $true }
    catch { return [bool]$_.Exception.Response }
}

function Get-OllamaExe {
    $exe = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:PROGRAMFILES\Ollama\ollama.exe"
    ) | Where-Object { Test-Path $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
    if (-not $exe) { $exe = "ollama" }
    return $exe
}

function Test-OllamaInstalled {
    # A concrete exe path resolved, or 'ollama' is on PATH.
    if ((Get-OllamaExe) -ne "ollama") { return $true }
    return [bool](Get-Command ollama -ErrorAction SilentlyContinue)
}

function Test-Model {
    param([string]$Name = $MODEL)
    try {
        $tags = Invoke-RestMethod -Uri "$OLLAMA_URL/api/tags" -TimeoutSec 5
        return (@($tags.models | Where-Object { $_.name -eq $Name -or $_.name -like "$Name*" }).Count -gt 0)
    } catch { return $false }
}

function Initialize-Model {
    param([string]$Name = $MODEL, [string]$Purpose = "It powers memory analysis and imports (a few GB download).")
    if (Test-Model $Name) {
        Write-Host "  [OK] Local model $Name is available" -ForegroundColor Green
        return
    }
    Write-Host ""
    Write-Host "  [!!] Local model '$Name' is not pulled yet." -ForegroundColor Yellow
    Write-Host "       $Purpose" -ForegroundColor DarkGray
    Write-Host -NoNewline "       Pull it now? [Y/n] " -ForegroundColor Cyan
    $k = [Console]::ReadKey($true)
    Write-Host $k.KeyChar
    if ($k.KeyChar -eq 'n' -or $k.KeyChar -eq 'N') {
        Write-Host "  Skipped. Pull it later with:  ollama pull $Name" -ForegroundColor DarkGray
        return
    }
    Write-Host "  [..] Pulling $Name (this can take a while)..." -ForegroundColor Yellow
    & (Get-OllamaExe) pull $Name
    if (Test-Model $Name) {
        Write-Host "  [OK] $Name pulled and ready" -ForegroundColor Green
    } else {
        Write-Host "  [!!] Pull did not complete. Retry later with:  ollama pull $Name" -ForegroundColor Red
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
    # Launch in its own window but tee every line to a persistent UTF-8 log,
    # so there's something to paste after the window is gone. stderr is merged
    # by cmd (not PowerShell) — PS 5.1 wraps native stderr in NativeCommandError
    # noise when it does the merge itself. The worker runs via -EncodedCommand
    # to sidestep nested-quoting breakage. $sidecarDir / $logPath / $RunCmd are
    # interpolated now; the backtick-escaped vars ($_, $log) run in the child.
    $logPath = Join-Path $sidecarDir "logs\sidecar.log"
    $worker = "`$ErrorActionPreference='SilentlyContinue'; Set-Location '$sidecarDir'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; `$log='$logPath'; if(-not (Test-Path (Split-Path `$log))){New-Item -ItemType Directory (Split-Path `$log)|Out-Null}; Add-Content -Path `$log -Value ('===== session start '+(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')+' =====') -Encoding UTF8; cmd /c 'npm.cmd $script:RunCmd 2>&1' | ForEach-Object { `$_; Add-Content -Path `$log -Value `$_ -Encoding UTF8 }; Write-Host ''; Write-Host 'Sidecar stopped. You can close this window. Log: memory-extender\logs\sidecar.log'"
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($worker))
    $script:SidecarProc = Start-Process "powershell.exe" `
        -ArgumentList "-NoLogo","-ExecutionPolicy","Bypass","-EncodedCommand",$enc `
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

# ── Bring-your-own-backend (non-Ollama) detection ────────────────────────────

$localUrl   = Get-EnvLocalUrl
$byoBackend = ($localUrl -ne "") -and ($localUrl -notmatch ':11434')
if ($byoBackend) {
    Write-Host "  [i] Custom local backend configured ($localUrl) - skipping Ollama setup." -ForegroundColor Cyan
    Write-Host "      Make sure that server is running with a model loaded (and an" -ForegroundColor DarkGray
    Write-Host "      embedding model too, if you want semantic recall)." -ForegroundColor DarkGray
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

if ($byoBackend) {
    # Custom backend — skip notice already printed; don't touch Ollama.
} elseif (Test-Ollama) {
    Write-Host "  [OK] Ollama is already running" -ForegroundColor Green
} elseif (-not (Test-OllamaInstalled)) {
    Write-Host "  [!!] Ollama is not installed." -ForegroundColor Yellow
    Write-Host "       It runs the local model that powers memory. Install it, then" -ForegroundColor DarkGray
    Write-Host "       run this launcher again:" -ForegroundColor DarkGray
    Write-Host "         https://ollama.com/download    (or:  winget install Ollama.Ollama)" -ForegroundColor Cyan
    Write-Host "       The sidecar still starts; local memory waits until Ollama is up." -ForegroundColor DarkGray
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

$localLabel = if ($byoBackend) { "Local backend  " } else { "Ollama         " }
$statusRow = [Console]::CursorTop
Write-Host "  $localLabel[?] ..."
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

    if (-not $ollamaOk)  { $ollamaOk  = if ($byoBackend) { Test-LocalBackend } else { Test-Ollama } }
    if (-not $sidecarOk) { $sidecarOk = Test-Sidecar }

    # Local-backend line (Ollama, or a custom OpenAI server)
    [Console]::SetCursorPosition(0, $statusRow)
    if ($ollamaOk) {
        Write-Host "  $localLabel[OK] Ready        " -ForegroundColor Green
    } else {
        Write-Host "  $localLabel[$spin]  Starting... " -ForegroundColor Yellow
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
        if (-not $ollamaOk) {
            if ($byoBackend) { Write-Host "  [!!] Custom backend at $localUrl did not respond." -ForegroundColor Red }
            else { Write-Host "  [!!] Ollama did not respond. Is it installed?" -ForegroundColor Red }
        }
        if (-not $sidecarOk) { Write-Host "  [!!] Memory Extender did not start. Check the npm window for errors." -ForegroundColor Red }
        Write-Host ""
        break
    }

    Start-Sleep -Milliseconds 300
}

# ── Ensure the local models are pulled ────────────────────────────────────────

if ($ollamaOk -and -not $byoBackend) {
    Initialize-Model
    Initialize-Model $EMBED_MODEL "It powers semantic recall - recaps and chunk-merge (small, ~275 MB)."
    Write-Host ""
}

# ── Browser extension — bridge from "sidecar running" to "loaded in Marinara" ──
# A newcomer otherwise lands on a running sidecar with a blank Marinara, because
# the extension still has to be installed in the engine. Always show where; open
# it automatically the first time so the step isn't silently skipped.

if ($sidecarOk) {
    $setupUrl = "$SIDECAR_URL/setup"
    $marker   = Join-Path $sidecarDir "logs\.setup-opened"  # runtime state, not memory — keep data/ clean
    Write-Host "  Browser extension:" -ForegroundColor Cyan
    Write-Host "    Install or refresh it from  $setupUrl" -ForegroundColor Gray
    Write-Host "    (follow the two steps there - upload the loader into Marinara)" -ForegroundColor DarkGray
    if (-not (Test-Path $marker)) {
        try {
            $markerDir = Split-Path $marker
            if (-not (Test-Path $markerDir)) { New-Item -ItemType Directory -Path $markerDir -Force | Out-Null }
            Start-Process $setupUrl
            Set-Content -Path $marker -Value (Get-Date -Format o) -Encoding UTF8
            Write-Host "    (opened it for you - looks like a first run)" -ForegroundColor DarkGray
        } catch {}
    }
    Write-Host ""
}

# ── Command console ─────────────────────────────────────────────────────────

$autoState = if (Test-Path $autostartFile) { "ON" } else { "off" }
$logPath = Join-Path $sidecarDir "logs\sidecar.log"
Write-Host "  Commands:  [R] Restart   [L] View log   [A] Auto-start ($autoState)   [Q] Quit (services keep running)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  A watchdog re-launches the server within ~15s if it dies, so a crash no" -ForegroundColor DarkGray
Write-Host "  longer means hours of stale memory. Leave this window open." -ForegroundColor DarkGray
Write-Host ""

# Non-blocking console + sidecar watchdog. The blocking ReadKey this replaced
# meant start.ps1 fired the server once and then slept forever on input — if the
# server died nothing noticed and the engine served a frozen lorebook for hours
# (the blind-crash bug).
#
# LIVENESS = THE PORT, NOT THE HTTP PROBE. The first cut used a 6s /api/health
# timeout as the death signal, but the sidecar runs the local model for
# tier-2/3 analysis WHILE the chat is generating, so a heavy turn makes the box
# compute-bound and the probe slow — and the watchdog was executing healthy-but-
# busy servers (~1 false restart/hour). A bound port is proof the process is
# alive; we only relaunch when 3001 has NO listener (the process is genuinely
# gone). A separate, deliberately patient guard covers the rare wedge (port
# bound but the server hung): only a long unbroken streak of failed probes —
# never a brief slow patch — counts as wedged.
$watchInterval = [TimeSpan]::FromSeconds(5)
$lastCheck = Get-Date
$portDown = 0      # consecutive checks with no listener on 3001 -> true death
$healthDown = 0    # consecutive failed probes while the port IS bound -> wedge

function Write-Prompt { Write-Host -NoNewline "  extender> " -ForegroundColor Cyan }
Write-Prompt

while ($true) {
    if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        $cmd = $key.KeyChar.ToString().ToLower()
        Write-Host $cmd
        if ($cmd -eq 'q') {
            break
        } elseif ($cmd -eq 'r') {
            Restart-Sidecar
            $lastCheck = Get-Date; $portDown = 0; $healthDown = 0
        } elseif ($cmd -eq 'l') {
            if (Test-Path $logPath) {
                Write-Host "  Last 30 lines of $logPath :" -ForegroundColor DarkGray
                Get-Content $logPath -Tail 30 | ForEach-Object { Write-Host "    $_" }
                Write-Host "  Opening full log in Notepad (close it when done)..." -ForegroundColor DarkGray
                Start-Process notepad.exe $logPath
            } else {
                Write-Host "  No log yet at $logPath - it appears once the server has started." -ForegroundColor Yellow
            }
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
            Write-Host "  Unknown command. [R] restart  [L] view log  [A] auto-start  [Q] quit." -ForegroundColor DarkGray
        }
        Write-Prompt
    }

    if (((Get-Date) - $lastCheck) -ge $watchInterval) {
        $lastCheck = Get-Date
        $portUp = [bool](Get-NetTCPConnection -LocalPort $SIDECAR_PORT -State Listen -ErrorAction SilentlyContinue)

        $dead = $false; $why = ""
        if (-not $portUp) {
            # Nothing is listening — the process is genuinely gone. Two checks
            # (~10s) to ride out the instant between a deliberate restart and the
            # new bind, then relaunch.
            $portDown++; $healthDown = 0
            if ($portDown -ge 2) { $dead = $true; $why = "process gone (no listener on port $SIDECAR_PORT)" }
        } else {
            # Port is bound = process alive. A slow probe here just means busy
            # (local model + chat generation contending), NOT dead — do not kill.
            # Only a long unbroken failure streak means a wedged server: 12 checks
            # at a 6s timeout is ~75s+ of continuous unresponsiveness, far beyond
            # any normal heavy turn.
            $portDown = 0
            if (Test-Sidecar) { $healthDown = 0 }
            else { $healthDown++; if ($healthDown -ge 12) { $dead = $true; $why = "wedged (port bound but /api/health failed $healthDown times)" } }
        }

        if ($dead) {
            $portDown = 0; $healthDown = 0
            Write-Host ""
            Write-Host "  [watchdog] Memory Extender down - $why - relaunching..." -ForegroundColor Red
            Add-Content -Path $logPath -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] [watchdog] $why - relaunching") -Encoding UTF8 -ErrorAction SilentlyContinue
            Stop-Sidecar          # frees the port whether the process died or just wedged
            Start-Sleep -Milliseconds 500
            Start-Sidecar
            $w = 0
            while (-not (Test-Sidecar) -and $w -lt 30) { Start-Sleep -Milliseconds 500; $w++ }
            if (Test-Sidecar) {
                Write-Host "  [watchdog] back up." -ForegroundColor Green
                Add-Content -Path $logPath -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] [watchdog] sidecar back up") -Encoding UTF8 -ErrorAction SilentlyContinue
            } else {
                Write-Host "  [watchdog] still down - check the sidecar window for errors." -ForegroundColor Yellow
            }
            $lastCheck = Get-Date
            Write-Prompt
        }
    }

    Start-Sleep -Milliseconds 200
}
