import { defineHost, GBRAIN_RESOLVERS, preambleToolGlossary } from './define-host';

// GitHub Copilot CLI (#393). Ported from PR #2323 (@andrey-esipov) with ideas
// from #396/#487 (@ridermw) and #1852 (@lolisaigao1234); disposition in
// docs/ADDING_A_HOST.md "GitHub Copilot CLI".
const COPILOT_TOOL_GLOSSARY = '**GitHub Copilot tool names:** `AskUserQuestion` means your `ask_user` tool (one question per call: put the decision brief in the question and each option in the choices). `ExitPlanMode` means `exit_plan_mode`; the Agent tool means `task`; the Read tool means `view`; the Skill tool means `skill`. Copilot has no `mcp__*__AskUserQuestion` variant.';

const COPILOT_SHELL_EXECUTION = `<!-- gstack:copilot-shell-execution:begin -->
## Shell execution

On Windows, apply this rule to every Bash fence in this skill and referenced files, including the preamble and later steps.
Execute each complete Bash fence in Git for Windows Bash, not by translating its commands into PowerShell.
Keep helper calls unchanged inside Bash fences so their existing shebangs select the right interpreter.
For separate PowerShell calls, explicitly invoke the native interpreter and arguments named by the shebang, such as Bun for Bun scripts or Python for Python scripts.
Do not force non-Bash helpers through Bash.
Never directly invoke extensionless gstack helpers with PowerShell's call operator or Start-Process; Windows can open a file picker instead.
Use a verified explicit path to Git for Windows Bash, not bare \`bash\` or \`bash.exe\`, which may select WSL.
Check the example path below; if Git is installed elsewhere, locate and verify its full \`bash.exe\` path before use.
If Git for Windows Bash is missing, report an explicit error and stop the shell step.
Do not change file associations.
On macOS and Linux, run Bash fences in your normal shell unchanged.

In PowerShell, paste the complete fence body into the single-quoted here-string below to preserve literal dollar signs such as \`$HOME\` and \`$(...)\`.
Keep both here-string delimiters on their own lines and the closing \`'@\` at column zero.
Use \`exit $LASTEXITCODE\` immediately after Bash so the tool reports its exit code.

\`\`\`powershell
$bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
if (-not (Test-Path -LiteralPath $bash -PathType Leaf)) {
    throw 'Git for Windows Bash is missing. Install Git for Windows or set $bash to its verified full path.'
}
$script = @'
printf '%s\\n' "$HOME"
'@
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script.Replace("\`r\`n", "\`n") | & $bash --noprofile --norc -s
exit $LASTEXITCODE
\`\`\`
<!-- gstack:copilot-shell-execution:end -->
`;

const copilot = defineHost({
  name: 'copilot',
  displayName: 'GitHub Copilot CLI',
  tier: 'experimental',
  capabilities: { toolExecution: true, questions: 'native', planMode: true, delegation: true, browser: true, safetyHooks: 'advisory' },

  localSkillRoot: '.github/skills/gstack',

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'error',
    conditionalFields: [
      { if: { sensitive: true }, add: { 'disable-model-invocation': true } },
    ],
  },
  generation: {
    generateMetadata: false,
    bodyPrefix: COPILOT_SHELL_EXECUTION,
  },

  // Literal ~/.copilot paths (the Cursor model, not Codex's $GSTACK_ROOT) so
  // skills without the preamble (careful, freeze, gstack-upgrade) still
  // resolve. .github/skills is Copilot's project skill directory. The runtime
  // root is not a checkout, so /gstack-upgrade finds the source through
  // .source-path (written by setup).
  pathRewrites: [
    { from: 'if [ -d "$HOME/.claude/skills/gstack/.git" ]', to: 'if [ -d "$(cat "$HOME/.copilot/skills/gstack/.source-path" 2>/dev/null)/.git" ]' },
    { from: 'INSTALL_DIR="$HOME/.claude/skills/gstack"', to: 'INSTALL_DIR="$(cat "$HOME/.copilot/skills/gstack/.source-path")"' },
    { from: '$HOME/.claude/skills/gstack', to: '$HOME/.copilot/skills/gstack' },
    { from: '~/.claude/skills/gstack', to: '~/.copilot/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.github/skills/gstack' },
    { from: '.claude/skills/review', to: '.github/skills/gstack/review' },
    { from: '.claude/skills', to: '.github/skills' },
  ],
  toolRewrites: preambleToolGlossary(COPILOT_TOOL_GLOSSARY),

  suppressedResolvers: ['REVIEW_ARMY', ...GBRAIN_RESOLVERS],
});

export default copilot;
