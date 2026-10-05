[CmdletBinding()]
param(
    [string]$SkillsRoot = (Join-Path $HOME '.copilot\skills'),
    [string]$BashPath,
    [switch]$BashOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [string]::IsNullOrWhiteSpace($BashPath)) {
    if (-not [System.IO.Path]::IsPathRooted($BashPath)) {
        throw "BashPath must be absolute: '$BashPath'."
    }
    $bash = [System.IO.Path]::GetFullPath($BashPath)
    if (-not (Test-Path -LiteralPath $bash -PathType Leaf)) {
        throw "BashPath does not exist: '$bash'."
    }
} else {
    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates.Add((Join-Path $env:ProgramFiles 'Git\bin\bash.exe'))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe'))
    }
    $bash = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $bash) {
        throw 'Git for Windows Bash is missing. Install Git for Windows or pass -BashPath with its verified absolute path.'
    }
}

$savedErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $versionOutput = @(& $bash --version 2>&1)
    $versionExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $savedErrorActionPreference
}
if ($versionExit -ne 0 -or $versionOutput.Count -eq 0 -or [string]$versionOutput[0] -notmatch '^GNU bash, version ') {
    throw "BashPath is not a working Git for Windows Bash executable: '$bash'.`n$($versionOutput -join "`n")"
}
Write-Output "EVIDENCE bash='$bash'."
Write-Output "EVIDENCE bash_version='$([string]$versionOutput[0])'."
if ($BashOnly) {
    Write-Output 'SUMMARY bash=ok startup=not-run protocol=not-run parent_pid=not-run openwith=not-run'
    return
}

$skillsRootPath = [System.IO.Path]::GetFullPath($SkillsRoot)
$start = Join-Path $skillsRootPath 'gstack\bin\gstack-skill-start'
if (-not (Test-Path -LiteralPath $start -PathType Leaf)) {
    throw "Missing installed startup helper at '$start'."
}

$probe = Join-Path ([System.IO.Path]::GetTempPath()) ('windows-gstack-patch-probe-' + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($probe) | Out-Null
@'
update_check: false
telemetry: off
proactive: false
explain_level: terse
routing_declined: true
artifacts_sync_mode: off
artifacts_sync_mode_prompted: true
'@ | Set-Content -LiteralPath (Join-Path $probe 'config.yaml') -Encoding UTF8
foreach ($marker in @(
    '.activated',
    '.first-loop-tip-shown',
    '.completeness-intro-seen',
    '.telemetry-prompted',
    '.proactive-prompted',
    '.feature-prompted-model-overlay'
)) {
    New-Item -ItemType File -Path (Join-Path $probe $marker) | Out-Null
}

$environmentNames = @(
    'HOME',
    'USERPROFILE',
    'GSTACK_STATE_ROOT',
    'GSTACK_HOME',
    'GSTACK_STATE_DIR',
    'CLAUDE_PLUGIN_DATA',
    'OPENCLAW_SESSION'
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$openWithBefore = @(Get-Process -Name OpenWith -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

try {
    foreach ($name in @('HOME', 'USERPROFILE', 'GSTACK_STATE_ROOT', 'GSTACK_HOME', 'GSTACK_STATE_DIR')) {
        [Environment]::SetEnvironmentVariable($name, $probe, 'Process')
    }
    [Environment]::SetEnvironmentVariable('CLAUDE_PLUGIN_DATA', $null, 'Process')
    [Environment]::SetEnvironmentVariable('OPENCLAW_SESSION', $null, 'Process')
    Push-Location $probe
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $bash --noprofile --norc $start --skill windows-gstack-patch --model none --parent-pid $PID 2>&1)
        $startupExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
        Pop-Location
    }

    Start-Sleep -Milliseconds 500
    $newOpenWith = @(Get-Process -Name OpenWith -ErrorAction SilentlyContinue |
        Where-Object { $_.Id -notin $openWithBefore } |
        Select-Object -ExpandProperty Id)
    $sessionPath = Join-Path $probe "sessions\$PID"
    if ($startupExit -ne 0) {
        throw "gstack-skill-start failed with exit code $startupExit.`n$($output -join "`n")"
    }
    if ($output.Count -eq 0 -or [string]$output[0] -cne 'SKILL_START_PROTO: 1') {
        throw "gstack-skill-start did not emit SKILL_START_PROTO: 1 first.`n$($output -join "`n")"
    }
    if ($output -notcontains 'MODEL_OVERLAY: none') {
        throw "gstack-skill-start did not accept --model none.`n$($output -join "`n")"
    }
    if (-not (Test-Path -LiteralPath $sessionPath -PathType Leaf)) {
        throw "gstack-skill-start did not honor --parent-pid $PID; missing '$sessionPath'."
    }
    if ($newOpenWith.Count -gt 0) {
        throw "The startup probe opened a Windows application picker. New OpenWith process IDs: $($newOpenWith -join ', ')."
    }

    Write-Output "EVIDENCE startup_exit=$startupExit."
    Write-Output "EVIDENCE protocol='$([string]$output[0])'."
    Write-Output "EVIDENCE model_overlay='none'."
    Write-Output "EVIDENCE parent_pid=$PID session='$sessionPath'."
    Write-Output 'EVIDENCE openwith_new=0.'
    Write-Output 'SUMMARY bash=ok startup=ok protocol=ok parent_pid=ok openwith=ok'
} finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    Remove-Item -LiteralPath $probe -Recurse -Force
}
