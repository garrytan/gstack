# Find the gstack browse binary (Windows). Echoes path and exits 0, or exits 1 if not found.
$Root = git rev-parse --show-toplevel 2>$null

$Candidates = @()
if ($Root) {
    $Candidates += Join-Path $Root '.claude\skills\gstack\browse\dist\browse.exe'
}
$Candidates += Join-Path $env:USERPROFILE '.claude\skills\gstack\browse\dist\browse.exe'

foreach ($c in $Candidates) {
    if (Test-Path $c) {
        Write-Output $c
        exit 0
    }
}

Write-Error 'ERROR: browse binary not found. Run: cd <skill-dir> && powershell -File setup.ps1'
exit 1
