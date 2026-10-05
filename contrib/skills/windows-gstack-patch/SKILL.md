---
name: windows-gstack-patch
description: "Repairs generated gstack skills for Copilot CLI on Windows after a gstack update. Use for \"patch gstack on Windows\", \"fix gstack after an update\", or \"stop gstack helpers opening the app picker\"."
---

# Patch generated gstack skills on Windows

Run this skill only on Windows. It patches the generated Copilot skill copies under the selected `skills` directory. It does not change the gstack checkout, reset an upgrade, rename helpers, or change file associations.

1. Resolve the directory of this loaded `SKILL.md`. Build absolute paths to `Apply-WindowsPatch.ps1` and `Verify-WindowsPatch.ps1`. Do not invoke an extensionless file. Set `$skillsRoot` to the user-supplied Copilot skills directory or the default below. Set `$bashPath` to a user-supplied absolute Git for Windows Bash path or `$null`.

   ```powershell
   $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
   $skillDirectory = [System.IO.Path]::GetFullPath('<absolute directory of this loaded skill>')
   $patch = Join-Path $skillDirectory 'Apply-WindowsPatch.ps1'
   $verify = Join-Path $skillDirectory 'Verify-WindowsPatch.ps1'
   $skillsRoot = Join-Path $HOME '.copilot\skills'
   $bashPath = $null
   ```

2. Verify Git for Windows Bash before any mutation. The verifier accepts only a working GNU Bash at the supplied absolute path or these installed locations, in order:
   - `%ProgramFiles%\Git\bin\bash.exe`
   - `%LocalAppData%\Programs\Git\bin\bash.exe`

   ```powershell
   $verifyArgs = @(
       '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
       '-File', $verify, '-SkillsRoot', $skillsRoot, '-BashOnly'
   )
   if ($bashPath) {
       $verifyArgs += @('-BashPath', $bashPath)
   }
   & $powershell @verifyArgs
   if ($LASTEXITCODE -ne 0) {
       throw "Verify-WindowsPatch.ps1 Bash preflight failed with exit code $LASTEXITCODE."
   }
   ```

   Stop if this fails. Do not use bare `bash`, `bash.exe`, or WSL.

3. Run the patch through the full Windows PowerShell executable path.

   ```powershell
   & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $patch -SkillsRoot $skillsRoot
   if ($LASTEXITCODE -ne 0) {
       throw "Apply-WindowsPatch.ps1 failed with exit code $LASTEXITCODE."
   }
   ```

   Pass `-WhatIf` for a preview. Pass `-BackupDirectory <absolute directory outside SkillsRoot>` to select the recovery-backup parent. Otherwise, the script creates a unique run directory under the system temporary directory. It validates every candidate and stages every changed file plus its recovery backup before the first atomic replacement. Preserve the reported backup directory until the installation is verified. Stop on any ownership, frontmatter, marker, UTF-8, reparse-point, backup, or staging error.

4. Run `copilot skill list`. This is a read-only check. Confirm that `windows-gstack-patch` appears under Personal and that the generated `gstack` skills still load.

5. Run the full verifier. It invokes the installed `gstack-skill-start` through the same explicit Bash path with isolated temporary state. It disables update checks, telemetry, proactive prompts, and artifact sync. It requires exit code `0`, `SKILL_START_PROTO: 1` as the first line, `MODEL_OVERLAY: none`, a session file keyed by the supplied `--parent-pid`, and no new `OpenWith.exe` process.

   ```powershell
   $verifyArgs = @(
       '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
       '-File', $verify, '-SkillsRoot', $skillsRoot
   )
   if ($bashPath) {
       $verifyArgs += @('-BashPath', $bashPath)
   }
   & $powershell @verifyArgs
   if ($LASTEXITCODE -ne 0) {
       throw "Verify-WindowsPatch.ps1 startup probe failed with exit code $LASTEXITCODE."
   }
   ```

6. Report the patch summary, every original-to-backup mapping, the `copilot skill list` result, and every `EVIDENCE` line from the verifier. Do not commit, push, open a pull request, run an upgrade, or edit upstream gstack files.
