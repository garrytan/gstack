# gstack setup (Windows) — build browser binary + register all skills with Claude Code
$ErrorActionPreference = 'Stop'

$GstackDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillsDir = Split-Path -Parent $GstackDir
$BrowseBin = Join-Path $GstackDir 'browse\dist\browse.exe'

function Test-PlaywrightBrowser {
    try {
        Push-Location $GstackDir
        bun --eval 'import { chromium } from "playwright"; const browser = await chromium.launch(); await browser.close();' 2>$null
        Pop-Location
        return $LASTEXITCODE -eq 0
    } catch {
        Pop-Location
        return $false
    }
}

# 1. Build browse binary if needed (smart rebuild: stale sources, package.json, lock)
$NeedsBuild = $false
if (-not (Test-Path $BrowseBin)) {
    $NeedsBuild = $true
} elseif (Get-ChildItem (Join-Path $GstackDir 'browse\src') -Recurse -File | Where-Object { $_.LastWriteTime -gt (Get-Item $BrowseBin).LastWriteTime } | Select-Object -First 1) {
    $NeedsBuild = $true
} elseif ((Get-Item (Join-Path $GstackDir 'package.json')).LastWriteTime -gt (Get-Item $BrowseBin).LastWriteTime) {
    $NeedsBuild = $true
} else {
    $BunLock = Join-Path $GstackDir 'bun.lock'
    if ((Test-Path $BunLock) -and (Get-Item $BunLock).LastWriteTime -gt (Get-Item $BrowseBin).LastWriteTime) {
        $NeedsBuild = $true
    }
}

if ($NeedsBuild) {
    Write-Host 'Building browse binary...'
    Push-Location $GstackDir
    bun install
    bun run build
    Pop-Location
}

if (-not (Test-Path $BrowseBin)) {
    Write-Error "gstack setup failed: browse binary missing at $BrowseBin"
    exit 1
}

# 2. Ensure Playwright's Chromium is available
if (-not (Test-PlaywrightBrowser)) {
    Write-Host 'Installing Playwright Chromium...'
    Push-Location $GstackDir
    bunx playwright install chromium
    Pop-Location
}

if (-not (Test-PlaywrightBrowser)) {
    Write-Error 'gstack setup failed: Playwright Chromium could not be launched'
    exit 1
}

# 3. Only create skill junctions if we're inside a .claude/skills directory
$SkillsBasename = Split-Path -Leaf $SkillsDir
if ($SkillsBasename -eq 'skills') {
    $linked = @()
    Get-ChildItem -Directory $GstackDir | ForEach-Object {
        $skillDir = $_.FullName
        $skillName = $_.Name
        if ($skillName -eq 'node_modules') { return }
        if (Test-Path (Join-Path $skillDir 'SKILL.md')) {
            $target = Join-Path $SkillsDir $skillName
            # Create or update junction; skip if a real directory exists
            $isJunction = $false
            if (Test-Path $target) {
                $item = Get-Item $target -Force
                $isJunction = $item.Attributes -band [IO.FileAttributes]::ReparsePoint
            }
            if ($isJunction -or -not (Test-Path $target)) {
                if (Test-Path $target) { Remove-Item $target -Force -Recurse }
                cmd /c mklink /J "$target" "$skillDir" | Out-Null
                $linked += $skillName
            }
        }
    }

    Write-Host 'gstack ready.'
    Write-Host "  browse: $BrowseBin"
    if ($linked.Count -gt 0) {
        Write-Host "  linked skills: $($linked -join ', ')"
    }
} else {
    Write-Host 'gstack ready.'
    Write-Host "  browse: $BrowseBin"
    Write-Host '  (skipped skill junctions - not inside .claude/skills/)'
}
