param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [string]$OutputPath,
    [string]$LockOutputPath,
    [string]$CoreSha256,
    [Parameter(Mandatory = $true)][string]$GitExePath,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$stagedOutput = $null
$stagedLockOutput = $null
$gitItem = Get-Item -LiteralPath ([System.IO.Path]::GetFullPath($GitExePath)) -Force
if ($gitItem.PSIsContainer -or ($gitItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    -not $gitItem.Name.Equals('git.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'CSO Windows build requires the resolved regular git.exe used by setup.'
}
$resolvedGit = $gitItem.FullName
if (-not $CheckOnly) {
    if (-not $OutputPath -or -not $LockOutputPath -or $CoreSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Normal CSO Windows builds require staged outputs and a lowercase SHA-256 core binding.' }
    $resolvedRepo = (Get-Item -LiteralPath $RepoRoot -Force).FullName
    $binRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedRepo 'bin')).TrimEnd('\')
    function Resolve-StagedOutput([string]$Value, [string]$ExpectedName) {
        $resolved = [System.IO.Path]::GetFullPath($Value)
        $parent = [System.IO.Path]::GetDirectoryName($resolved)
        $parentItem = Get-Item -LiteralPath $parent -Force
        $directParent = [System.IO.Path]::GetDirectoryName($parent)
        if ([System.IO.Path]::GetFileName($resolved) -cne $ExpectedName -or
            [System.IO.Path]::GetFileName($parent) -notlike '.gstack-cso-stage.*' -or
            -not $directParent.Equals($binRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            ($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'CSO Windows native output must be a direct, non-reparse staging directory under the repository bin directory.'
        }
        return $resolved
    }
    $stagedOutput = Resolve-StagedOutput $OutputPath 'gstack-cso-launcher.exe'
    $stagedLockOutput = Resolve-StagedOutput $LockOutputPath 'gstack-cso-publish-lock.exe'
}

# Use the installed MSVC toolchain, not a Bun-hosted launcher or downloaded
# compiler. This works from Git Bash without a preconfigured Developer Prompt.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw 'CSO Windows build requires Visual Studio 2022 Build Tools with the Desktop development with C++ workload.'
}
$installation = & $vswhere -latest -products '*' -version '[17.0,)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) {
    throw 'CSO Windows build requires the Visual Studio 2022 MSVC x64 toolchain and Windows SDK.'
}
$devShell = Join-Path ([string]$installation) 'Common7\Tools\Launch-VsDevShell.ps1'
if (-not (Test-Path -LiteralPath $devShell -PathType Leaf)) { throw 'MSVC Developer PowerShell initialization is unavailable.' }
& $devShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
$compiler = (Get-Command cl.exe -ErrorAction Stop).Source
$installationPrefix = [System.IO.Path]::GetFullPath([string]$installation).TrimEnd('\') + '\'
if (-not [System.IO.Path]::GetFullPath($compiler).StartsWith($installationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'MSVC initialization selected a compiler outside the discovered Visual Studio installation.'
}
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('gstack-cso-msvc-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    if ($CheckOnly) {
        $source = Join-Path $temporary 'probe.c'
        $output = Join-Path $temporary 'probe.exe'
        Set-Content -LiteralPath $source -Encoding Ascii -NoNewline -Value 'int main(void) { return 0; }'
        $object = Join-Path $temporary 'probe.obj'
        & $compiler /nologo /std:c11 /W4 /WX /O2 /MT /GS /guard:cf /D_CRT_SECURE_NO_WARNINGS "/Fo$object" "/Fe$output" $source /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA
        if ($LASTEXITCODE -ne 0) { throw "Native CSO Windows compiler probe failed ($LASTEXITCODE)." }
        if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'Native CSO Windows compiler probe was not produced.' }
    } else {
        $binding = Join-Path $temporary 'core-binding.h'
        $gitLiteral = $resolvedGit.Replace('\', '\\').Replace('"', '\"')
        Set-Content -LiteralPath $binding -Encoding Ascii -Value "#define GSTACK_CSO_CORE_SHA256 `"$CoreSha256`"`n#define GSTACK_CSO_GIT_PATH L`"$gitLiteral`""
        $builds = @(
            @{ Source = (Join-Path $RepoRoot 'lib\cso\launcher-windows.c'); Output = [string]$stagedOutput; Object = 'launcher.obj'; Binding = $true },
            @{ Source = (Join-Path $RepoRoot 'lib\cso\publish-lock.c'); Output = [string]$stagedLockOutput; Object = 'publish-lock.obj'; Binding = $false }
        )
        foreach ($build in $builds) {
            $object = Join-Path $temporary $build.Object
            $forcedInclude = if ($build.Binding) { "/FI$binding" } else { @() }
            & $compiler /nologo /std:c11 /W4 /WX /O2 /MT /GS /guard:cf /D_CRT_SECURE_NO_WARNINGS $forcedInclude "/Fo$object" "/Fe$($build.Output)" $build.Source /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA
            if ($LASTEXITCODE -ne 0) { throw "Native CSO Windows helper compilation failed ($LASTEXITCODE)." }
            if (-not (Test-Path -LiteralPath $build.Output -PathType Leaf)) { throw 'Native CSO Windows output was not produced.' }
        }
    }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
