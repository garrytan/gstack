param(
  [Parameter(Mandatory = $true)][string]$OutputRoot,
  [switch]$Child,
  [switch]$Initialized,
  [string]$ExpectedSid,
  [string]$BinDirectory,
  [string]$GitDirectory
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true') {
  throw 'Native cookie qualification requires a disposable GitHub Actions Windows runner.'
}
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

if ($Child) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.User.Value -ne $ExpectedSid) { throw 'Unexpected qualification account identity.' }
  $registered = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$ExpectedSid").ProfileImagePath
  $registered = [Environment]::ExpandEnvironmentVariables($registered)
  $env:USERPROFILE = $registered
  $env:HOME = $registered
  $folders = [Microsoft.Win32.Registry]::Users.OpenSubKey("$ExpectedSid\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
  if (-not $folders) { throw 'The new account known-folder registry is unavailable.' }
  try {
    $rawLocal = $folders.GetValue('Local AppData', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $rawRoaming = $folders.GetValue('AppData', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (-not $rawLocal -or -not $rawRoaming) { throw 'The new account app-data folders are undefined.' }
    $env:LOCALAPPDATA = [Environment]::ExpandEnvironmentVariables($rawLocal)
    $env:APPDATA = [Environment]::ExpandEnvironmentVariables($rawRoaming)
  } finally { $folders.Dispose() }
  if (-not $Initialized) {
    & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -NonInteractive -File $PSCommandPath -Child -Initialized -ExpectedSid $ExpectedSid -BinDirectory $BinDirectory -GitDirectory $GitDirectory -OutputRoot $OutputRoot
    exit $LASTEXITCODE
  }
  $profile = [Environment]::GetFolderPath('UserProfile')
  $local = [Environment]::GetFolderPath('LocalApplicationData', 'DoNotVerify')
  $roaming = [Environment]::GetFolderPath('ApplicationData', 'DoNotVerify')
  if ($profile -ne $registered -or -not $local.StartsWith($profile + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Write-Output (ConvertTo-Json -Compress @{ profileMatchesRegistered = ($profile -eq $registered); localInsideProfile = $local.StartsWith($profile + '\', [StringComparison]::OrdinalIgnoreCase); localEmpty = [string]::IsNullOrEmpty($local); localMatchesInherited = ($local -eq $env:LOCALAPPDATA) })
    throw 'Qualification must use the new account real Windows profile.'
  }
  $keep = @('SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'PATHEXT')
  Get-ChildItem Env: | Where-Object { $_.Name -notin $keep } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
  $env:USERPROFILE = $profile
  $env:HOME = $profile
  $env:LOCALAPPDATA = $local
  $env:APPDATA = $roaming
  $env:TEMP = Join-Path $local 'Temp'
  $env:TMP = $env:TEMP
  $env:PATH = "$BinDirectory;$GitDirectory\cmd;$GitDirectory\bin;$GitDirectory\usr\bin;$env:SystemRoot\System32;$env:SystemRoot"
  $env:CI = 'true'
  $env:GITHUB_ACTIONS = 'true'
  New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
  Set-Location $repository
  & (Join-Path $BinDirectory 'bun.exe') install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & (Join-Path $GitDirectory 'bin\bash.exe') browse/scripts/build-node-server.sh
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & (Join-Path $BinDirectory 'bun.exe') --no-env-file --no-install --no-macros --config=NUL browse/test/cookie-import-native-qualification.ts $OutputRoot
  exit $LASTEXITCODE
}

$work = Join-Path $OutputRoot ('cookie-native-host-' + [Guid]::NewGuid().ToString('N'))
$bin = Join-Path $work 'bin'
$evidence = Join-Path $work 'evidence'
$snapshot = Join-Path $work 'repository'
New-Item -ItemType Directory -Path $work | Out-Null
$name = 'gstack' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$password = ConvertTo-SecureString ([Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) + '!aA1') -AsPlainText -Force
$account = $null
$process = $null
$exitCode = 1
try {
  $account = New-LocalUser -Name $name -Password $password -AccountExpires (Get-Date).AddHours(1) -Description 'Disposable gstack cookie qualification'
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
  $principal = "$env:COMPUTERNAME\$name"
  & icacls.exe $work /grant "${principal}:(OI)(CI)M" /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant fixture output access.' }
  New-Item -ItemType Directory -Path $bin, $evidence, $snapshot | Out-Null
  $archive = Join-Path $work 'source.tar'
  & git -C $repository archive --format=tar -o $archive HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Could not snapshot the candidate source.' }
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $archive -C $snapshot
  if ($LASTEXITCODE -ne 0) { throw 'Could not materialize the isolated source snapshot.' }
  Copy-Item (Get-Command bun).Source (Join-Path $bin 'bun.exe')
  Copy-Item (Get-Command node).Source (Join-Path $bin 'node.exe')
  $gitDirectory = Split-Path (Split-Path (Get-Command git).Source)
  if (-not (Test-Path (Join-Path $gitDirectory 'bin\bash.exe'))) { throw 'Git Bash is required for the isolated Node build.' }
  $childScript = Join-Path $snapshot '.github\scripts\run-cookie-native-qualification.ps1'
  $credential = [Management.Automation.PSCredential]::new($principal, $password)
  $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', ('"' + $childScript + '"'), '-Child', '-ExpectedSid', $account.SID.Value,
    '-BinDirectory', ('"' + $bin + '"'), '-GitDirectory', ('"' + $gitDirectory + '"'), '-OutputRoot', ('"' + $evidence + '"'))
  $process = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $arguments -Credential $credential -LoadUserProfile -WorkingDirectory $snapshot -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work 'stdout.log') -RedirectStandardError (Join-Path $work 'stderr.log')
  $null = $process.Handle
  if (-not $process.WaitForExit(360000)) {
    $process.Kill($true)
    throw 'Native qualification exceeded its launcher deadline.'
  }
  if ($null -eq $process.ExitCode) { throw 'Native qualification did not return an exit status.' }
  $exitCode = $process.ExitCode
  foreach ($file in Get-ChildItem $evidence -Filter qualification.json -Recurse) {
    $receipt = Get-Content $file.FullName -Raw | ConvertFrom-Json
    if ($receipt.status -eq 'passed') {
      $expected = (Get-FileHash (Join-Path $repository 'browse\dist\server-node.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($receipt.qualifiedBuild.sourceHashes.'browse/dist/server-node.mjs' -ne $expected) {
        throw 'The qualified Node bundle differs from the candidate workspace build.'
      }
    }
  }
} finally {
  try {
    if ($process -and -not $process.HasExited) { $process.Kill($true) }
  } finally {
    try {
      if (Test-Path (Join-Path $work 'stdout.log')) { Get-Content (Join-Path $work 'stdout.log') }
      if (Test-Path (Join-Path $work 'stderr.log')) { Get-Content (Join-Path $work 'stderr.log') }
      if (Test-Path $evidence) { Get-ChildItem $evidence -Directory -Filter 'cookie-native-qualification-*' | Copy-Item -Destination $OutputRoot -Recurse }
    } finally {
      try { if ($account) { Remove-LocalUser -SID $account.SID } }
      finally { $password.Dispose() }
    }
  }
}
exit $exitCode
