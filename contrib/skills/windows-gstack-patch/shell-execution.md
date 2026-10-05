<!-- gstack:copilot-shell-execution:begin -->
## Shell execution

On Windows, apply this rule to every Bash fence in this skill and referenced files, including the preamble and later steps.
Execute each complete Bash fence in Git for Windows Bash, not by translating its commands into PowerShell.
Keep helper calls unchanged inside Bash fences so their existing shebangs select the right interpreter.
For separate PowerShell calls, explicitly invoke the native interpreter and arguments named by the shebang, such as Bun for Bun scripts or Python for Python scripts.
Do not force non-Bash helpers through Bash.
Never directly invoke extensionless gstack helpers with PowerShell's call operator or Start-Process; Windows can open a file picker instead.
Use a verified explicit path to Git for Windows Bash, not bare `bash` or `bash.exe`, which may select WSL.
Check the example path below; if Git is installed elsewhere, locate and verify its full `bash.exe` path before use.
If Git for Windows Bash is missing, report an explicit error and stop the shell step.
Do not change file associations.
On macOS and Linux, run Bash fences in your normal shell unchanged.

In PowerShell, paste the complete fence body into the single-quoted here-string below to preserve literal dollar signs such as `$HOME` and `$(...)`.
Keep both here-string delimiters on their own lines and the closing `'@` at column zero.
Use `exit $LASTEXITCODE` immediately after Bash so the tool reports its exit code.

```powershell
$bash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path -LiteralPath $bash -PathType Leaf)) {
    throw 'Git for Windows Bash is missing. Install Git for Windows or set $bash to its verified full path.'
}
$script = @'
printf '%s\n' "$HOME"
'@
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script.Replace("`r`n", "`n") | & $bash --noprofile --norc -s
exit $LASTEXITCODE
```
<!-- gstack:copilot-shell-execution:end -->
