[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SkillsRoot = (Join-Path $HOME '.copilot\skills'),
    [string]$BackupDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$beginMarker = '<!-- gstack:copilot-shell-execution:begin -->'
$endMarker = '<!-- gstack:copilot-shell-execution:end -->'
$generatedBanner = '<!-- AUTO-GENERATED from'
$strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$plainUtf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8Document {
    param([string]$Path)

    [byte[]]$bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $offset = 0
    if ($hasBom) {
        $offset = 3
    }

    try {
        $text = $script:strictUtf8.GetString($bytes, $offset, $bytes.Length - $offset)
    } catch {
        throw "Expected UTF-8 text at '$Path': $($_.Exception.Message)"
    }

    [pscustomobject]@{
        HasBom = $hasBom
        Text = $text
    }
}

function ConvertTo-Utf8Bytes {
    param(
        [string]$Text,
        [bool]$HasBom
    )

    [byte[]]$body = $script:plainUtf8.GetBytes($Text)
    if (-not $HasBom) {
        return ,$body
    }

    [byte[]]$preamble = (New-Object System.Text.UTF8Encoding($true)).GetPreamble()
    [byte[]]$result = New-Object byte[] ($preamble.Length + $body.Length)
    [System.Array]::Copy($preamble, 0, $result, 0, $preamble.Length)
    [System.Array]::Copy($body, 0, $result, $preamble.Length, $body.Length)
    return ,$result
}

function Get-OccurrenceCount {
    param(
        [string]$Text,
        [string]$Needle
    )

    $count = 0
    $offset = 0
    while (($index = $Text.IndexOf($Needle, $offset, [System.StringComparison]::Ordinal)) -ge 0) {
        $count++
        $offset = $index + $Needle.Length
    }
    $count
}

function Test-PathInsideRoot {
    param(
        [string]$Path,
        [string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if ([string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $prefix = $fullRoot + [System.IO.Path]::DirectorySeparatorChar
    $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePoints {
    param(
        [string]$Path,
        [string]$Root
    )

    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $current = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not (Test-PathInsideRoot -Path $current -Root $fullRoot)) {
        throw "Path escapes SkillsRoot: '$current'."
    }

    while ($true) {
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Refusing reparse point in patch path: '$current'. Windows Copilot skill installs must be real files and directories."
        }
        if ([string]::Equals($current, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $current, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Cannot walk '$Path' back to SkillsRoot '$fullRoot'."
        }
        $current = $parent.TrimEnd('\', '/')
    }
}

$skillsRootPath = [System.IO.Path]::GetFullPath($SkillsRoot)
if (-not (Test-Path -LiteralPath $skillsRootPath -PathType Container)) {
    throw "SkillsRoot does not exist: '$skillsRootPath'."
}
Assert-NoReparsePoints -Path $skillsRootPath -Root $skillsRootPath

$payloadPath = Join-Path $PSScriptRoot 'shell-execution.md'
$payloadDocument = Read-Utf8Document -Path $payloadPath
$payload = $payloadDocument.Text.Replace("`r`n", "`n")
if ((Get-OccurrenceCount -Text $payload -Needle $beginMarker) -ne 1 -or
    (Get-OccurrenceCount -Text $payload -Needle $endMarker) -ne 1 -or
    $payload.IndexOf($beginMarker, [System.StringComparison]::Ordinal) -ge
        $payload.IndexOf($endMarker, [System.StringComparison]::Ordinal)) {
    throw "The canonical payload at '$payloadPath' has malformed shell-execution markers."
}
if (-not $payload.EndsWith("`n", [System.StringComparison]::Ordinal)) {
    throw "The canonical payload at '$payloadPath' must end with LF."
}

$candidates = New-Object System.Collections.Generic.List[object]
foreach ($directory in @(Get-ChildItem -LiteralPath $skillsRootPath -Directory -Force)) {
    if ($directory.Name -ne 'gstack' -and -not $directory.Name.StartsWith('gstack-', [System.StringComparison]::Ordinal)) {
        continue
    }
    $skillPath = Join-Path $directory.FullName 'SKILL.md'
    if (Test-Path -LiteralPath $skillPath -PathType Leaf) {
        $candidates.Add([pscustomobject]@{
            Path = $skillPath
            ExpectedName = $directory.Name
        })
    }
}

$runtimeSkills = @(
    @{ RelativePath = 'gstack-upgrade\SKILL.md'; ExpectedName = 'gstack-upgrade' },
    @{ RelativePath = 'office-hours\SKILL.md'; ExpectedName = 'gstack-office-hours' }
)
$runtimeRoot = Join-Path $skillsRootPath 'gstack'
foreach ($runtimeSkill in $runtimeSkills) {
    $skillPath = Join-Path $runtimeRoot $runtimeSkill.RelativePath
    if (Test-Path -LiteralPath $skillPath -PathType Leaf) {
        $candidates.Add([pscustomobject]@{
            Path = $skillPath
            ExpectedName = $runtimeSkill.ExpectedName
        })
    }
}

$plans = New-Object System.Collections.Generic.List[object]
$skipped = 0
foreach ($candidate in @($candidates | Sort-Object Path -Unique)) {
    Assert-NoReparsePoints -Path $candidate.Path -Root $skillsRootPath

    $document = Read-Utf8Document -Path $candidate.Path
    $content = $document.Text
    if ($content.IndexOf($generatedBanner, [System.StringComparison]::Ordinal) -lt 0) {
        Write-Output "SKIPPED user-owned '$($candidate.Path)': no generated banner."
        $skipped++
        continue
    }

    $frontmatter = [regex]::Match(
        $content,
        '\A---(?:\r?\n)(?<body>.*?)(?:\r?\n)---(?<after>\r?\n|\z)',
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )
    if (-not $frontmatter.Success) {
        throw "Malformed generated SKILL.md frontmatter at '$($candidate.Path)'."
    }
    $nameMatches = [regex]::Matches(
        $frontmatter.Groups['body'].Value,
        '(?m)^[ \t]*name:[ \t]*(?<name>[a-z][a-z0-9-]*)[ \t]*$'
    )
    if ($nameMatches.Count -ne 1) {
        throw "Generated SKILL.md at '$($candidate.Path)' must contain exactly one plain name field."
    }
    $actualName = $nameMatches[0].Groups['name'].Value
    if ($actualName -cne $candidate.ExpectedName) {
        throw "Generated SKILL.md at '$($candidate.Path)' has name '$actualName'; expected '$($candidate.ExpectedName)'."
    }

    $beginCount = Get-OccurrenceCount -Text $content -Needle $beginMarker
    $endCount = Get-OccurrenceCount -Text $content -Needle $endMarker
    if (($beginCount -eq 0) -xor ($endCount -eq 0)) {
        throw "Unbalanced shell-execution markers at '$($candidate.Path)'."
    }
    if ($beginCount -gt 1 -or $endCount -gt 1) {
        throw "Duplicate shell-execution markers at '$($candidate.Path)'."
    }

    if ($beginCount -eq 1) {
        $begin = $content.IndexOf($beginMarker, [System.StringComparison]::Ordinal)
        $end = $content.IndexOf($endMarker, [System.StringComparison]::Ordinal)
        if ($begin -lt $frontmatter.Length -or $end -lt $begin) {
            throw "Malformed shell-execution marker order at '$($candidate.Path)'."
        }
        $firstFence = [regex]::Match(
            $content.Substring($frontmatter.Length),
            '(?m)^[ \t]*(?:```|~~~)'
        )
        if ($firstFence.Success -and $begin -gt ($frontmatter.Length + $firstFence.Index)) {
            throw "Misplaced shell-execution prefix after a code fence at '$($candidate.Path)'."
        }
        $replaceEnd = $end + $endMarker.Length
        if ($content.Substring($replaceEnd).StartsWith("`r`n", [System.StringComparison]::Ordinal)) {
            $replaceEnd += 2
        } elseif ($content.Substring($replaceEnd).StartsWith("`n", [System.StringComparison]::Ordinal)) {
            $replaceEnd++
        }
        $newContent = $content.Substring(0, $begin) + $payload + $content.Substring($replaceEnd)
    } else {
        $newContent = $content.Substring(0, $frontmatter.Length) + "`n" + $payload + $content.Substring($frontmatter.Length)
    }

    $plans.Add([pscustomobject]@{
        Path = $candidate.Path
        RelativePath = $candidate.Path.Substring($skillsRootPath.TrimEnd('\', '/').Length).TrimStart('\', '/')
        Bytes = ConvertTo-Utf8Bytes -Text $newContent -HasBom $document.HasBom
        Changed = $newContent -cne $content
    })
}

$changed = 0
$unchanged = @($plans | Where-Object { -not $_.Changed }).Count
$planned = 0
$approved = New-Object System.Collections.Generic.List[object]
foreach ($plan in @($plans | Where-Object Changed)) {
    if ($PSCmdlet.ShouldProcess($plan.Path, 'Install the canonical Copilot shell-execution prefix')) {
        $approved.Add($plan)
    } else {
        $planned++
    }
}

if ($approved.Count -gt 0) {
    $backupParent = if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
        [System.IO.Path]::GetTempPath()
    } else {
        if (-not [System.IO.Path]::IsPathRooted($BackupDirectory)) {
            throw "BackupDirectory must be absolute: '$BackupDirectory'."
        }
        [System.IO.Path]::GetFullPath($BackupDirectory)
    }
    if (Test-PathInsideRoot -Path $backupParent -Root $skillsRootPath) {
        throw "BackupDirectory must be outside SkillsRoot: '$backupParent'."
    }

    $runBackupDirectory = Join-Path $backupParent ('windows-gstack-patch-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($runBackupDirectory) | Out-Null
    Write-Output "BACKUP-DIRECTORY '$runBackupDirectory'."

    $staged = New-Object System.Collections.Generic.List[object]
    foreach ($plan in $approved) {
        $backupPath = Join-Path $runBackupDirectory $plan.RelativePath
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $backupPath)) | Out-Null
        [System.IO.File]::Copy($plan.Path, $backupPath, $false)

        $tempPath = Join-Path (Split-Path -Parent $plan.Path) ('.windows-gstack-patch-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $replaceBackupPath = Join-Path (Split-Path -Parent $plan.Path) ('.windows-gstack-patch-' + [guid]::NewGuid().ToString('N') + '.replace-backup')
        [System.IO.File]::WriteAllBytes($tempPath, [byte[]]$plan.Bytes)
        Write-Output "BACKUP '$($plan.Path)' -> '$backupPath'."
        $staged.Add([pscustomobject]@{
            Path = $plan.Path
            TempPath = $tempPath
            ReplaceBackupPath = $replaceBackupPath
        })
    }

    foreach ($write in $staged) {
        [System.IO.File]::Replace($write.TempPath, $write.Path, $write.ReplaceBackupPath)
        Write-Output "CHANGED '$($write.Path)'."
        $changed++
    }
    foreach ($write in $staged) {
        [System.IO.File]::Delete($write.ReplaceBackupPath)
    }
}

Write-Output "SUMMARY changed=$changed unchanged=$unchanged skipped=$skipped planned=$planned"
