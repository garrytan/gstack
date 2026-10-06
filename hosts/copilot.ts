import { defineHost, GBRAIN_RESOLVERS, preambleToolGlossary } from './define-host';

// GitHub Copilot CLI (#393). Ported from PR #2323 (@andrey-esipov) with ideas
// from #396/#487 (@ridermw) and #1852 (@lolisaigao1234); disposition in
// docs/ADDING_A_HOST.md "GitHub Copilot CLI".
// On Windows: Git Bash note (#3047).
const COPILOT_TOOL_GLOSSARY = '**GitHub Copilot tool names:** `AskUserQuestion` means your `ask_user` tool (one question per call: put the decision brief in the question and each option in the choices). `ExitPlanMode` means `exit_plan_mode`; the Agent tool means `task`; the Read tool means `view`; the Skill tool means `skill`. Copilot has no `mcp__*__AskUserQuestion` variant. **On Windows:** run each bash block in Git for Windows Bash by its full path (usually `C:\\Program Files\\Git\\bin\\bash.exe`; bare `bash` can start WSL instead). Never translate a block into PowerShell, and never run an extensionless gstack helper from PowerShell directly: Windows opens an app picker instead of running it.';

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
