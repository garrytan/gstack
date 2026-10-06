---
name: windows-gstack-patch
description: "Repairs generated gstack skills for Copilot CLI on Windows after a gstack update. Use for \"patch gstack on Windows\", \"fix gstack after an update\", or \"stop gstack helpers opening the app picker\"."
---

# Patch generated gstack skills on Windows

Windows only. Patch generated gstack skill copies, including project registrations discovered by Copilot. Preserve names and host metadata. Do not change tracked sources, reset an upgrade, rename helpers, or change file associations.

1. Resolve this loaded skill's directory and its two `.ps1` scripts to absolute paths. Never invoke extensionless helpers directly. Use the supplied personal skills root and absolute Git Bash path, or these defaults.

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
       throw "Verify-WindowsPatch.ps1 failed with exit code $LASTEXITCODE."
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

   `-WhatIf` previews without writing. `-BackupDirectory <absolute directory outside SkillsRoot>` chooses the backup parent; otherwise backups go in a unique system-temp directory. All candidates validate and stage with recovery backups before atomic replacement. Keep backups until verification passes. Stop on ownership, frontmatter, marker, UTF-8, reparse-point, backup, or staging errors.

4. Run `copilot skill list`. Require Personal `windows-gstack-patch` and generated gstack skills to load.

   Copilot also discovers project copies generated for Codex. Repeat Step 3's command and exit guard for each existing repository `.agents\skills` and `.github\skills` directory, passing `$projectSkillsRoot` as `-SkillsRoot`. Keep `$skillsRoot` on the personal installation for Step 5; project copies may lack a runtime. Only generated `gstack` and `gstack-*` directories qualify, with a frontmatter name matching the directory or its unprefixed skill name. Keep backups. Do not regenerate Codex copies as Copilot skills or delete registrations.

   Rerun `copilot skill list` and invoke the repaired project skill through the skill tool. Require `gstack:copilot-shell-execution:begin` before its first executable fence. Personal startup success alone does not prove project discovery. Reapply after project-host regeneration or upgrades.

5. Run the full verifier. It invokes the installed `gstack-skill-start` through the same explicit Bash path with isolated temporary state. It disables update checks, telemetry, proactive prompts, and artifact sync. It requires exit code `0`, `SKILL_START_PROTO: 1` as the first line, `MODEL_OVERLAY: none`, a session file keyed by the supplied `--parent-pid`, and no new `OpenWith.exe` process.

   Repeat Step 2's verifier command without `-BashOnly`, retaining the explicit interpreter, personal `$skillsRoot`, optional `$bashPath`, and nonzero-exit guard.

6. Report the patch summary for every root, every original-to-backup mapping, the `copilot skill list` and loaded-skill results, and every `EVIDENCE` line from the verifier. Do not commit, push, open a pull request, run an upgrade, or edit upstream gstack files.
