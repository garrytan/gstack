#Requires -Version 5.1
<#
.SYNOPSIS
    Windows prerequisite wrapper for ./setup (Git Bash).

.DESCRIPTION
    Checks for Node.js, Bun, and Git. Installs any missing prerequisites
    via winget, then delegates to ./setup running inside Git Bash.

.PARAMETER args
    All arguments are forwarded to ./setup (e.g. --no-browser, --prefix).
    --auto-close   Close the Git Bash window immediately on completion.
    --keep-open    Keep the Git Bash window open indefinitely after completion.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$CloseDelaySecs = 20   # seconds before auto-close in default (prompt) mode

# ---------------------------------------------------------------------------
# Parse ps1-only flags (consumed here; remainder forwarded to ./setup)
# ---------------------------------------------------------------------------
$AutoClose = $false
$KeepOpen  = $false
$forwardArgs = [System.Collections.Generic.List[string]]::new()
foreach ($a in $args) {
    switch ($a) {
        '--auto-close' { $AutoClose = $true }
        '--keep-open'  { $KeepOpen  = $true }
        default        { $forwardArgs.Add($a) }
    }
}

function Write-Step { param([string]$msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. Check winget
# ---------------------------------------------------------------------------
Write-Step "Checking winget..."
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Warn "winget not found. Install 'App Installer' from the Microsoft Store,"
    Write-Warn "or install prerequisites manually:"
    Write-Warn "  Node.js : https://nodejs.org"
    Write-Warn "  Bun     : https://bun.sh"
    Write-Warn "  Git     : https://git-scm.com"
    Write-Warn "Then re-run this script."
    # Don't exit — if prereqs are already installed we can still proceed
    $hasWinget = $false
} else {
    Write-Ok "winget available"
    $hasWinget = $true
}

# ---------------------------------------------------------------------------
# Helper: refresh PATH from registry so freshly installed tools are visible
# ---------------------------------------------------------------------------
function Update-SessionPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH = "$machinePath;$userPath"
}

# ---------------------------------------------------------------------------
# Helper: install a package via winget and refresh PATH
# ---------------------------------------------------------------------------
function Install-Prereq {
    param([string]$Name, [string]$WingetId)
    if (-not $hasWinget) {
        Write-Fail "$Name is required but winget is unavailable. Install it manually and re-run."
        exit 1
    }
    Write-Step "Installing $Name via winget..."
    winget install --id=$WingetId -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "winget failed to install $Name (exit $LASTEXITCODE). Install manually and re-run."
        exit 1
    }
    Update-SessionPath
    Write-Ok "$Name installed"
}

# ---------------------------------------------------------------------------
# 2. Check prerequisites
# ---------------------------------------------------------------------------
Write-Step "Checking prerequisites..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warn "node not found"
    Install-Prereq -Name "Node.js" -WingetId "OpenJS.NodeJS"
} else {
    Write-Ok "node $(node --version)"
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Warn "bun not found"
    Install-Prereq -Name "Bun" -WingetId "Oven-sh.Bun"
} else {
    Write-Ok "bun $(bun --version)"
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Warn "git not found"
    Install-Prereq -Name "Git" -WingetId "Git.Git"
    Update-SessionPath
} else {
    Write-Ok "git $(git --version)"
}

# ---------------------------------------------------------------------------
# 3. Locate git-bash.exe
# ---------------------------------------------------------------------------
Write-Step "Locating git-bash.exe..."

$gitBash = $null

$candidates = @(
    "C:\Program Files\Git\git-bash.exe",
    "C:\Program Files (x86)\Git\git-bash.exe"
)

foreach ($c in $candidates) {
    if (Test-Path $c) { $gitBash = $c; break }
}

if (-not $gitBash) {
    # Derive from git.exe location
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        $gitExe = $gitCmd.Source
        $candidate = Join-Path (Split-Path (Split-Path $gitExe)) "git-bash.exe"
        if (Test-Path $candidate) { $gitBash = $candidate }
    }
}

if (-not $gitBash) {
    Write-Fail "git-bash.exe not found. Ensure Git for Windows is installed."
    Write-Fail "Download from https://git-scm.com/download/win"
    exit 1
}

Write-Ok "git-bash.exe → $gitBash"

# ---------------------------------------------------------------------------
# 4. Convert script directory to Unix path for Git Bash
# ---------------------------------------------------------------------------
$unixDir = $PSScriptRoot -replace '\\', '/' -replace '^([A-Za-z]):', {
    "/$($_.Groups[1].Value.ToLower())"
}

# ---------------------------------------------------------------------------
# 5. Delegate to ./setup inside Git Bash
# ---------------------------------------------------------------------------
$argStr = $forwardArgs -join ' '

Write-Step "Running ./setup $argStr inside Git Bash..."
if ($KeepOpen) {
    Write-Host "  Keeping bash open" -ForegroundColor DarkGray
} elseif ($AutoClose) {
    Write-Host "  Auto-closing bash on completion" -ForegroundColor DarkGray
} else {
    Write-Host "  Bash closes ${CloseDelaySecs}s after completion" -ForegroundColor DarkGray
}
Write-Host ""

# Delegate to ./setup via a command string to avoid temp file race conditions and encoding issues
if ($KeepOpen) {
    $bashCmd = "cd '$unixDir'; ./setup $argStr; exec bash"
} elseif ($AutoClose) {
    $bashCmd = "cd '$unixDir' && ./setup $argStr"
} else {
    # Default: show result, then wait before closing (allowing 'n' to drop to shell)
    # Uses backticks to escape PowerShell interpolation for bash variables
    $bashCmd = "cd '$unixDir' && ./setup $argStr; _ec=`$?; printf '\nAutoclose [Y/n] (auto-closes in ${CloseDelaySecs}s): '; read -t $CloseDelaySecs -n 1 _key; echo; case ""`$_key"" in [Nn]*) exec bash --login -i ;; *) exit `$_ec ;; esac"
}

& $gitBash -c "$bashCmd"
exit $LASTEXITCODE
