import { defineHost, GBRAIN_RESOLVERS, preambleToolGlossary } from './define-host';

// Google Gemini CLI (#1247). Paths: user skills in ~/.gemini/skills, workspace
// skills in .gemini/skills (trusted folders only), found at <dir>/<name>/SKILL.md
// and indexed by frontmatter name (geminicli.com/docs/cli/skills). Tool names:
// Gemini CLI 0.66.0. Google's migration table lists ~/.gemini/skills as an
// Antigravity CLI global path too, so the glossary maps agy's names as well.
// Verified facts in docs/ADDING_A_HOST.md "Gemini CLI".
const GEMINI_TOOL_GLOSSARY = '**Gemini CLI tool names:** `AskUserQuestion` means your `ask_user` tool; there is no `mcp__*__AskUserQuestion` variant. The Bash tool means `run_shell_command`, the Read tool `read_file`, the Write tool `write_file`, the Edit tool `replace`, Grep `grep_search`, Glob `glob`, the Agent tool `invoke_agent`, and `ExitPlanMode` means `exit_plan_mode`. The Skill tool means `activate_skill`, or reading the skill\'s SKILL.md with `read_file`. In Antigravity CLI, which can read these skills too, use `run_command`, `view_file` and `ask_question` instead.';

const gemini = defineHost({
  name: 'gemini',
  displayName: 'Gemini CLI',
  cliAliases: ['gemini-cli'],
  defaultModel: 'gemini',
  tier: 'experimental',
  capabilities: { toolExecution: true, questions: 'native', planMode: true, delegation: true, browser: true, safetyHooks: 'advisory' },

  globalRoot: '.gemini/skills/gstack',
  localSkillRoot: '.gemini/skills/gstack',
  // Render output only: .gemini is Gemini CLI's own workspace directory, so a
  // render there would be listed as workspace skills in this repo.
  hostSubdir: '.gemini-cli',

  // Gemini CLI indexes skills by frontmatter name, so names match their
  // gstack-<skill> directories. 1024 is the Agent Skills description limit.
  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'error',
    nameMatchesDirectory: true,
  },

  // Literal ~/.gemini/skills paths (the agy model); .source-path (written by
  // setup) lets /gstack-upgrade find the checkout behind the runtime root.
  pathRewrites: [
    { from: 'if [ -d "$HOME/.claude/skills/gstack/.git" ]', to: 'if [ -d "$(cat "$HOME/.gemini/skills/gstack/.source-path" 2>/dev/null)/.git" ]' },
    { from: 'INSTALL_DIR="$HOME/.claude/skills/gstack"', to: 'INSTALL_DIR="$(cat "$HOME/.gemini/skills/gstack/.source-path")"' },
    { from: '$HOME/.claude/skills/gstack', to: '$HOME/.gemini/skills/gstack' },
    { from: '~/.claude/skills/gstack', to: '~/.gemini/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.gemini/skills/gstack' },
    { from: '.claude/skills/review', to: '.gemini/skills/gstack/review' },
    { from: '.claude/skills', to: '.gemini/skills' },
    { from: 'CLAUDE.md', to: 'GEMINI.md' },
  ],
  toolRewrites: preambleToolGlossary(GEMINI_TOOL_GLOSSARY),

  suppressedResolvers: ['REVIEW_ARMY', ...GBRAIN_RESOLVERS],

  runtimeRoot: {
    globalSymlinks: ['bin', 'lib', 'browse/dist', 'browse/bin', 'design/dist', 'make-pdf/dist', 'freeze/bin', 'careful/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },
});

export default gemini;
