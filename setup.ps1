# gstack setup — build browser binary + register skills with Claude Code / Codex / Kiro
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ─── Administrative Check ──────────────────────────────────────
function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    Write-Warning "Administrator privileges are required to create symbolic links on Windows."
    $response = Read-Host "Relaunch as Administrator? (Y/N)"
    if ($response -eq 'Y') {
        Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
        exit
    } else {
        Write-Host "[!] Aborted: Insufficient permissions." -ForegroundColor Red
        exit 1
    }
}

function Test-Command {
    param($Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# ─── Dependency Checks ─────────────────────────────────────────

# 1. Bun
if (-not (Test-Command "bun")) {
    Write-Host "`n[!] Error: Bun is required but not found." -ForegroundColor Red
    Write-Host "Install: " -NoNewline; Write-Host "winget install -e --id Oven-sh.Bun`n" -ForegroundColor Cyan
    exit 1
}

# 2. Node.js
if (-not (Test-Command "node")) {
    Write-Host "`n[!] Error: Node.js is required for Playwright stability on Windows." -ForegroundColor Red
    Write-Host "Install: " -NoNewline; Write-Host "winget install -e --id OpenJS.NodeJS`n" -ForegroundColor Cyan
    exit 1
}

# 3. Git
if (-not (Test-Command "git")) {
    Write-Host "`n[!] Error: Git is required to version the build." -ForegroundColor Red
    Write-Host "Install: " -NoNewline; Write-Host "winget install -e --id Git.Git`n" -ForegroundColor Cyan
    exit 1
}

# ─── Parse Flags ──────────────────────────────────────────────
$HOST_TARGET = "claude"
$LOCAL_INSTALL = $false
$i = 0
while ($i -lt $args.Count) {
    switch ($args[$i]) {
        "--host" {
            if ($i + 1 -ge $args.Count) {
                Write-Host "Missing value for --host (expected claude, codex, kiro, or auto)" -ForegroundColor Red
                exit 1
            }
            $HOST_TARGET = $args[$i + 1]
            $i += 2
        }
        { $_ -match "^--host=" } {
            $HOST_TARGET = $_ -replace "^--host=", ""
            $i += 1
        }
        "--local" {
            $LOCAL_INSTALL = $true
            $i += 1
        }
        default { $i += 1 }
    }
}

$validHosts = @("claude", "codex", "kiro", "auto")
if ($HOST_TARGET -notin $validHosts) {
    Write-Host "Unknown --host value: $HOST_TARGET (expected claude, codex, kiro, or auto)" -ForegroundColor Red
    exit 1
}

# ─── Setup Paths ───────────────────────────────────────────────
$SOURCE_GSTACK_DIR = (Get-Item $PSScriptRoot).FullName
$INSTALL_GSTACK_DIR = $PSScriptRoot
$INSTALL_SKILLS_DIR = Split-Path -Parent $INSTALL_GSTACK_DIR
$BROWSE_BIN = Join-Path $SOURCE_GSTACK_DIR "browse\dist\browse.exe"
$CODEX_SKILLS = Join-Path $HOME ".codex\skills"
$CODEX_GSTACK = Join-Path $CODEX_SKILLS "gstack"

# --local: install to .claude/skills/ in the current working directory
if ($LOCAL_INSTALL) {
    if ($HOST_TARGET -eq "codex") {
        Write-Host "Error: --local is only supported for Claude Code (not Codex)." -ForegroundColor Red
        exit 1
    }
    $INSTALL_SKILLS_DIR = Join-Path (Get-Location).Path ".claude\skills"
    if (-not (Test-Path $INSTALL_SKILLS_DIR)) {
        New-Item -ItemType Directory -Path $INSTALL_SKILLS_DIR -Force | Out-Null
    }
    $HOST_TARGET = "claude"
}

# ─── Auto-detect installed agents ─────────────────────────────
$INSTALL_CLAUDE = $false
$INSTALL_CODEX = $false
$INSTALL_KIRO = $false

switch ($HOST_TARGET) {
    "auto" {
        if (Test-Command "claude") { $INSTALL_CLAUDE = $true }
        if (Test-Command "codex")  { $INSTALL_CODEX = $true }
        if (Test-Command "kiro-cli") { $INSTALL_KIRO = $true }
        # If none found, default to claude
        if (-not $INSTALL_CLAUDE -and -not $INSTALL_CODEX -and -not $INSTALL_KIRO) {
            $INSTALL_CLAUDE = $true
        }
    }
    "claude" { $INSTALL_CLAUDE = $true }
    "codex"  { $INSTALL_CODEX = $true }
    "kiro"   { $INSTALL_KIRO = $true }
}

# ─── Helper Functions ──────────────────────────────────────────

function New-SymLink {
    param(
        [Parameter(Mandatory)] [string]$Source,
        [Parameter(Mandatory)] [string]$Target
    )

    $absTargetDir = Split-Path -Parent $Target
    if (-not (Test-Path $absTargetDir)) {
        New-Item -ItemType Directory -Path $absTargetDir -Force | Out-Null
    }

    # Clean up existing before linking
    if (Test-Path $Target) {
        $item = Get-Item $Target -Force
        if ($item.Attributes -match "ReparsePoint") {
            Remove-Item $Target -Force
        } elseif (Test-Path $Target -PathType Container) {
            Remove-Item $Target -Recurse -Force
        } else {
            Remove-Item $Target -Force
        }
    }

    New-Item -ItemType SymbolicLink -Path $Target -Value $Source -Force | Out-Null
}

function Link-ClaudeSkillDirs {
    param(
        [Parameter(Mandatory)] [string]$GstackDir,
        [Parameter(Mandatory)] [string]$SkillsDir
    )
    $linked = @()
    foreach ($dir in (Get-ChildItem -Path $GstackDir -Directory)) {
        $skillMd = Join-Path $dir.FullName "SKILL.md"
        if (Test-Path $skillMd) {
            if ($dir.Name -eq "node_modules") { continue }
            $target = Join-Path $SkillsDir $dir.Name
            # Create or update symlink; skip if a real (non-symlink) file/directory exists
            $existing = $null
            if (Test-Path $target) { $existing = Get-Item $target -Force }
            if ($null -eq $existing -or ($existing.Attributes -match "ReparsePoint")) {
                New-SymLink -Source $dir.FullName -Target $target
                $linked += $dir.Name
            }
        }
    }
    if ($linked.Count -gt 0) {
        Write-Host "  linked skills: $($linked -join ' ')"
    }
}

function Link-CodexSkillDirs {
    param(
        [Parameter(Mandatory)] [string]$GstackDir,
        [Parameter(Mandatory)] [string]$SkillsDir
    )
    $agentsDir = Join-Path $GstackDir ".agents\skills"
    $linked = @()

    if (-not (Test-Path $agentsDir)) {
        Write-Host "  Generating .agents/ skill docs..."
        Push-Location $GstackDir
        bun run gen:skill-docs --host codex
        Pop-Location
    }

    if (-not (Test-Path $agentsDir)) {
        Write-Warning ".agents/skills/ generation failed — run 'bun run gen:skill-docs --host codex' manually"
        return
    }

    foreach ($dir in (Get-ChildItem -Path $agentsDir -Directory -Filter "gstack*")) {
        $skillMd = Join-Path $dir.FullName "SKILL.md"
        if (Test-Path $skillMd) {
            # Skip the sidecar directory
            if ($dir.Name -eq "gstack") { continue }
            $target = Join-Path $SkillsDir $dir.Name
            $existing = $null
            if (Test-Path $target) { $existing = Get-Item $target -Force }
            if ($null -eq $existing -or ($existing.Attributes -match "ReparsePoint")) {
                New-SymLink -Source $dir.FullName -Target $target
                $linked += $dir.Name
            }
        }
    }
    if ($linked.Count -gt 0) {
        Write-Host "  linked skills: $($linked -join ' ')"
    }
}

function New-AgentsSidecar {
    param(
        [Parameter(Mandatory)] [string]$RepoRoot
    )
    $agentsGstack = Join-Path $RepoRoot ".agents\skills\gstack"
    if (-not (Test-Path $agentsGstack)) {
        New-Item -ItemType Directory -Path $agentsGstack -Force | Out-Null
    }

    # Sidecar directories that skills reference at runtime
    foreach ($asset in @("bin", "browse", "review", "qa")) {
        $src = Join-Path $SOURCE_GSTACK_DIR $asset
        $dst = Join-Path $agentsGstack $asset
        if (Test-Path $src) {
            $existing = $null
            if (Test-Path $dst) { $existing = Get-Item $dst -Force }
            if ($null -eq $existing -or ($existing.Attributes -match "ReparsePoint")) {
                New-SymLink -Source $src -Target $dst
            }
        }
    }

    # Sidecar files that skills reference at runtime
    foreach ($file in @("ETHOS.md")) {
        $src = Join-Path $SOURCE_GSTACK_DIR $file
        $dst = Join-Path $agentsGstack $file
        if (Test-Path $src) {
            $existing = $null
            if (Test-Path $dst) { $existing = Get-Item $dst -Force }
            if ($null -eq $existing -or ($existing.Attributes -match "ReparsePoint")) {
                New-SymLink -Source $src -Target $dst
            }
        }
    }
}

function New-CodexRuntimeRoot {
    param(
        [Parameter(Mandatory)] [string]$GstackDir,
        [Parameter(Mandatory)] [string]$CodexGstack
    )
    $agentsDir = Join-Path $GstackDir ".agents\skills"

    # Clean up old installs
    if (Test-Path $CodexGstack) {
        $item = Get-Item $CodexGstack -Force
        if ($item.Attributes -match "ReparsePoint") {
            Remove-Item $CodexGstack -Force
        } elseif ($CodexGstack -ne $GstackDir) {
            Remove-Item $CodexGstack -Recurse -Force
        }
    }

    New-Item -ItemType Directory -Path $CodexGstack -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $CodexGstack "browse") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $CodexGstack "gstack-upgrade") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $CodexGstack "review") -Force | Out-Null

    # Root SKILL.md
    $rootSkill = Join-Path $agentsDir "gstack\SKILL.md"
    if (Test-Path $rootSkill) {
        New-SymLink -Source $rootSkill -Target (Join-Path $CodexGstack "SKILL.md")
    }
    # bin/
    $binDir = Join-Path $GstackDir "bin"
    if (Test-Path $binDir) {
        New-SymLink -Source $binDir -Target (Join-Path $CodexGstack "bin")
    }
    # browse/dist/
    $browseDist = Join-Path $GstackDir "browse\dist"
    if (Test-Path $browseDist) {
        New-SymLink -Source $browseDist -Target (Join-Path $CodexGstack "browse\dist")
    }
    # browse/bin/
    $browseBin = Join-Path $GstackDir "browse\bin"
    if (Test-Path $browseBin) {
        New-SymLink -Source $browseBin -Target (Join-Path $CodexGstack "browse\bin")
    }
    # gstack-upgrade SKILL.md
    $upgradeSkill = Join-Path $agentsDir "gstack-upgrade\SKILL.md"
    if (Test-Path $upgradeSkill) {
        New-SymLink -Source $upgradeSkill -Target (Join-Path $CodexGstack "gstack-upgrade\SKILL.md")
    }
    # Review runtime assets (individual files, NOT the whole review/ dir)
    foreach ($f in @("checklist.md", "design-checklist.md", "greptile-triage.md", "TODOS-format.md")) {
        $src = Join-Path $GstackDir "review\$f"
        if (Test-Path $src) {
            New-SymLink -Source $src -Target (Join-Path $CodexGstack "review\$f")
        }
    }
    # ETHOS.md
    $ethos = Join-Path $GstackDir "ETHOS.md"
    if (Test-Path $ethos) {
        New-SymLink -Source $ethos -Target (Join-Path $CodexGstack "ETHOS.md")
    }
}

function Ensure-PlaywrightBrowser {
    # On Windows, Bun can't launch Chromium (oven-sh/bun#4253). Use Node.js.
    Push-Location $SOURCE_GSTACK_DIR
    try {
        $result = node -e "const { chromium } = require('playwright'); (async () => { const b = await chromium.launch(); await b.close(); })()" 2>&1
        $success = $LASTEXITCODE -eq 0
    } catch {
        $success = $false
    }
    Pop-Location
    return $success
}

# ─── 1. Build Browse Binary ─────────────────────────────────────
$NEEDS_BUILD = $false
if (-not (Test-Path $BROWSE_BIN)) {
    $NEEDS_BUILD = $true
} else {
    $binTime = (Get-Item $BROWSE_BIN).LastWriteTime
    $srcPath = Join-Path $SOURCE_GSTACK_DIR "browse\src"
    if (Test-Path $srcPath) {
        $latestSrc = Get-ChildItem -Path $srcPath -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latestSrc -and $latestSrc.LastWriteTime -gt $binTime) { $NEEDS_BUILD = $true }
    }
    $pkgJson = Join-Path $SOURCE_GSTACK_DIR "package.json"
    if ((Test-Path $pkgJson) -and (Get-Item $pkgJson).LastWriteTime -gt $binTime) { $NEEDS_BUILD = $true }
    $bunLock = Join-Path $SOURCE_GSTACK_DIR "bun.lock"
    if ((Test-Path $bunLock) -and (Get-Item $bunLock).LastWriteTime -gt $binTime) { $NEEDS_BUILD = $true }
}

if ($NEEDS_BUILD) {
    Write-Host "Building browse binary..." -ForegroundColor Gray
    Push-Location $SOURCE_GSTACK_DIR
    bun install
    bun run build
    Pop-Location
    # Safety net: write .version if build script didn't
    $versionFile = Join-Path $SOURCE_GSTACK_DIR "browse\dist\.version"
    if (-not (Test-Path $versionFile)) {
        git -C $SOURCE_GSTACK_DIR rev-parse HEAD | Out-File -FilePath $versionFile -Encoding utf8
    }
}

if (-not (Test-Path $BROWSE_BIN)) {
    Write-Host "gstack setup failed: browse binary missing at $BROWSE_BIN" -ForegroundColor Red
    exit 1
}

# 1b. Generate .agents/ Codex skill docs — always regenerate to prevent stale descriptions
$AGENTS_DIR = Join-Path $SOURCE_GSTACK_DIR ".agents\skills"
if (-not $NEEDS_BUILD) {
    Write-Host "Generating .agents/ skill docs..." -ForegroundColor Gray
    Push-Location $SOURCE_GSTACK_DIR
    try { bun install --frozen-lockfile 2>$null } catch { bun install }
    bun run gen:skill-docs --host codex
    Pop-Location
}

# ─── 2. Playwright Verification ─────────────────────────────────
if (-not (Ensure-PlaywrightBrowser)) {
    Write-Host "Installing Playwright Chromium..." -ForegroundColor Gray
    Push-Location $SOURCE_GSTACK_DIR
    bunx playwright install chromium
    # Verify Node can load Playwright
    Write-Host "Windows detected — verifying Node.js can load Playwright..."
    $nodeCheck = node -e "require('playwright')" 2>&1
    if ($LASTEXITCODE -ne 0) {
        npm install --no-save playwright
    }
    Pop-Location
}

if (-not (Ensure-PlaywrightBrowser)) {
    Write-Host "gstack setup failed: Playwright Chromium could not be launched via Node.js" -ForegroundColor Red
    Write-Host "  This is a known issue with Bun on Windows (oven-sh/bun#4253)." -ForegroundColor Red
    Write-Host "  Ensure Node.js is installed and 'node -e `"require('playwright')`"' works." -ForegroundColor Red
    exit 1
}

# ─── 3. Ensure ~/.gstack global state directory exists ──────────
$GSTACK_GLOBAL = Join-Path $HOME ".gstack\projects"
if (-not (Test-Path $GSTACK_GLOBAL)) {
    New-Item -ItemType Directory -Path $GSTACK_GLOBAL -Force | Out-Null
}

# ─── Detect repo-local Codex install ────────────────────────────
$SKILLS_BASENAME = Split-Path $INSTALL_SKILLS_DIR -Leaf
$SKILLS_PARENT_BASENAME = Split-Path (Split-Path $INSTALL_SKILLS_DIR -Parent) -Leaf
$CODEX_REPO_LOCAL = ($SKILLS_BASENAME -eq "skills") -and ($SKILLS_PARENT_BASENAME -eq ".agents")

# ─── 4. Install for Claude ─────────────────────────────────────
if ($INSTALL_CLAUDE) {
    if ($SKILLS_BASENAME -eq "skills") {
        Link-ClaudeSkillDirs -GstackDir $SOURCE_GSTACK_DIR -SkillsDir $INSTALL_SKILLS_DIR
        if ($LOCAL_INSTALL) {
            Write-Host "gstack ready (project-local)." -ForegroundColor Green
            Write-Host "  skills: $INSTALL_SKILLS_DIR"
        } else {
            Write-Host "gstack ready (claude)." -ForegroundColor Green
        }
        Write-Host "  browse: $BROWSE_BIN"
    } else {
        Write-Host "gstack ready (claude)." -ForegroundColor Green
        Write-Host "  browse: $BROWSE_BIN"
        Write-Host "  (skipped skill symlinks — not inside .claude/skills/)"
    }
}

# ─── 5. Install for Codex ──────────────────────────────────────
if ($INSTALL_CODEX) {
    if ($CODEX_REPO_LOCAL) {
        $CODEX_SKILLS = $INSTALL_SKILLS_DIR
        $CODEX_GSTACK = $INSTALL_GSTACK_DIR
    }
    if (-not (Test-Path $CODEX_SKILLS)) {
        New-Item -ItemType Directory -Path $CODEX_SKILLS -Force | Out-Null
    }

    # Skip runtime root creation for repo-local installs
    if (-not $CODEX_REPO_LOCAL) {
        New-CodexRuntimeRoot -GstackDir $SOURCE_GSTACK_DIR -CodexGstack $CODEX_GSTACK
    }
    # Install generated Codex-format skills
    Link-CodexSkillDirs -GstackDir $SOURCE_GSTACK_DIR -SkillsDir $CODEX_SKILLS

    Write-Host "gstack ready (codex)." -ForegroundColor Green
    Write-Host "  browse: $BROWSE_BIN"
    Write-Host "  codex skills: $CODEX_SKILLS"
}

# ─── 6. Install for Kiro ───────────────────────────────────────
if ($INSTALL_KIRO) {
    $KIRO_SKILLS = Join-Path $HOME ".kiro\skills"
    $KIRO_GSTACK = Join-Path $KIRO_SKILLS "gstack"
    if (-not (Test-Path $KIRO_SKILLS)) {
        New-Item -ItemType Directory -Path $KIRO_SKILLS -Force | Out-Null
    }

    # Clean up old symlink
    if ((Test-Path $KIRO_GSTACK) -and ((Get-Item $KIRO_GSTACK -Force).Attributes -match "ReparsePoint")) {
        Remove-Item $KIRO_GSTACK -Force
    }

    New-Item -ItemType Directory -Path $KIRO_GSTACK -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $KIRO_GSTACK "browse") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $KIRO_GSTACK "gstack-upgrade") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $KIRO_GSTACK "review") -Force | Out-Null

    # Runtime asset symlinks
    New-SymLink -Source (Join-Path $SOURCE_GSTACK_DIR "bin") -Target (Join-Path $KIRO_GSTACK "bin")
    $browseDist = Join-Path $SOURCE_GSTACK_DIR "browse\dist"
    if (Test-Path $browseDist) {
        New-SymLink -Source $browseDist -Target (Join-Path $KIRO_GSTACK "browse\dist")
    }
    $browseBinDir = Join-Path $SOURCE_GSTACK_DIR "browse\bin"
    if (Test-Path $browseBinDir) {
        New-SymLink -Source $browseBinDir -Target (Join-Path $KIRO_GSTACK "browse\bin")
    }
    # ETHOS.md
    $ethos = Join-Path $SOURCE_GSTACK_DIR "ETHOS.md"
    if (Test-Path $ethos) {
        New-SymLink -Source $ethos -Target (Join-Path $KIRO_GSTACK "ETHOS.md")
    }
    # gstack-upgrade
    $upgradeSkill = Join-Path $AGENTS_DIR "gstack-upgrade\SKILL.md"
    if (Test-Path $upgradeSkill) {
        New-SymLink -Source $upgradeSkill -Target (Join-Path $KIRO_GSTACK "gstack-upgrade\SKILL.md")
    }
    # Review runtime assets
    foreach ($f in @("checklist.md", "design-checklist.md", "greptile-triage.md", "TODOS-format.md")) {
        $src = Join-Path $SOURCE_GSTACK_DIR "review\$f"
        if (Test-Path $src) {
            New-SymLink -Source $src -Target (Join-Path $KIRO_GSTACK "review\$f")
        }
    }

    # Rewrite root SKILL.md paths for Kiro
    $skillMdContent = Get-Content (Join-Path $SOURCE_GSTACK_DIR "SKILL.md") -Raw
    $skillMdContent = $skillMdContent -replace "~/.claude/skills/gstack", "~/.kiro/skills/gstack"
    $skillMdContent = $skillMdContent -replace "\.claude/skills/gstack", ".kiro/skills/gstack"
    $skillMdContent = $skillMdContent -replace "\.claude/skills", ".kiro/skills"
    $skillMdContent | Out-File -FilePath (Join-Path $KIRO_GSTACK "SKILL.md") -Encoding utf8

    # Link generated Codex-format skills with path rewriting
    if (-not (Test-Path $AGENTS_DIR)) {
        Write-Warning "no .agents/skills/ directory found — run 'bun run build' first"
    } else {
        foreach ($dir in (Get-ChildItem -Path $AGENTS_DIR -Directory -Filter "gstack*")) {
            $skillMd = Join-Path $dir.FullName "SKILL.md"
            if (-not (Test-Path $skillMd)) { continue }
            $targetDir = Join-Path $KIRO_SKILLS $dir.Name
            if (-not (Test-Path $targetDir)) {
                New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
            }
            $content = Get-Content $skillMd -Raw
            $content = $content -replace '\$HOME/.codex/skills/gstack', '$HOME/.kiro/skills/gstack'
            $content = $content -replace "~/.codex/skills/gstack", "~/.kiro/skills/gstack"
            $content = $content -replace "~/.claude/skills/gstack", "~/.kiro/skills/gstack"
            $content | Out-File -FilePath (Join-Path $targetDir "SKILL.md") -Encoding utf8
        }
        Write-Host "gstack ready (kiro)." -ForegroundColor Green
        Write-Host "  browse: $BROWSE_BIN"
        Write-Host "  kiro skills: $KIRO_SKILLS"
    }
}

# ─── 7. Create .agents/ sidecar symlinks ───────────────────────
if ($INSTALL_CODEX) {
    New-AgentsSidecar -RepoRoot $SOURCE_GSTACK_DIR
}

# ─── 8. First-time welcome + cleanup ───────────────────────────
$gstackHome = Join-Path $HOME ".gstack"
if (-not (Test-Path $gstackHome)) {
    New-Item -ItemType Directory -Path $gstackHome -Force | Out-Null
    Write-Host "  Welcome! Run /gstack-upgrade anytime to stay current."
}

$tmpVersion = Join-Path $env:TEMP "gstack-latest-version"
if (Test-Path $tmpVersion) { Remove-Item $tmpVersion }
