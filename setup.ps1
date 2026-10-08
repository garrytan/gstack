#Requires -Version 5.1
<#
.SYNOPSIS
    Windows entry point for gstack's ./setup.

.DESCRIPTION
    Checks that Git for Windows, Bun and Node.js are on PATH, then runs ./setup
    from this directory in Git Bash. Every argument goes to ./setup unchanged,
    as separate arguments; none is pasted into shell source.

        .\setup.ps1
        .\setup.ps1 --host codex

    Set GSTACK_GIT_BASH to a bash.exe to use instead of Git for Windows' own.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$missing = @(
    @{ Cmd = 'git';  Name = 'Git for Windows'; Id = 'Git.Git' },
    @{ Cmd = 'bun';  Name = 'Bun';             Id = 'Oven-sh.Bun' },
    @{ Cmd = 'node'; Name = 'Node.js';         Id = 'OpenJS.NodeJS.LTS' }
) | Where-Object { -not (Get-Command $_.Cmd -CommandType Application -ErrorAction SilentlyContinue) }
if ($missing) {
    Write-Host 'gstack setup needs these on PATH first:'
    foreach ($tool in $missing) { Write-Host ('  {0}: winget install --id {1} -e' -f $tool.Name, $tool.Id) }
    Write-Host 'Install them, open a new PowerShell window and run .\setup.ps1 again. Nothing was installed or changed.'
    exit 1
}

# Git Bash, found from git.exe (Git\cmd, Git\bin or Git\mingw64\bin). Never a
# bare `bash` from PATH: on Windows that is often WSL's, with a different home.
$bash = $env:GSTACK_GIT_BASH
if (-not $bash) {
    $dir = Split-Path (Get-Command git -CommandType Application | Select-Object -First 1).Source
    for ($i = 0; $i -lt 3 -and $dir; $i++) {
        $candidate = Join-Path $dir 'bin\bash.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $bash = $candidate; break }
        $dir = Split-Path $dir
    }
}
if (-not $bash -or -not (Test-Path -LiteralPath $bash -PathType Leaf)) {
    Write-Host 'Git Bash (bash.exe) was not found next to git. Reinstall Git for Windows, or set GSTACK_GIT_BASH to its bash.exe.'
    exit 1
}

Push-Location -LiteralPath $PSScriptRoot
try {
    & $bash -c 'exec ./setup "$@"' setup @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $code
