import { defineHost, GBRAIN_RESOLVERS, preambleToolGlossary } from './define-host';

// Google Antigravity CLI, named after its `agy` binary: the longer name pushed
// the runtime prelude past PRELUDE_BYTE_BUDGET. Rewritten on defineHost() from
// the community attempts; disposition and doc sources in docs/ADDING_A_HOST.md
// "Antigravity CLI".
// Paths: the CLI reads global skills from ~/.gemini/antigravity-cli/skills and
// workspace skills from .agents/skills (antigravity.google/docs/skills, CLI
// section). Tool names: antigravity.google/docs/hooks "Supported tools".
const ANTIGRAVITY_TOOL_GLOSSARY = '**Antigravity tool names:** `AskUserQuestion` means your `ask_question` tool (options as choices); there is no `mcp__*__AskUserQuestion` variant. The Bash tool means `run_command`, the Read tool `view_file`, the Write tool `write_to_file`, the Edit tool `replace_file_content` (`multi_replace_file_content` for several edits in one file), Grep `grep_search`, Glob `find_by_name`, and the Agent tool `invoke_subagent`. There is no Skill tool: load a skill by reading its SKILL.md with `view_file`. If a step says to call `ExitPlanMode`, tell the user the plan is ready and wait. `view_file` can return only part of a long file: when a SKILL.md or a file it tells you to read ends before its last line, read the remaining line ranges before acting on it.';

const agy = defineHost({
  name: 'agy',
  displayName: 'Antigravity CLI',
  cliAliases: ['antigravity'],
  defaultModel: 'gemini',
  tier: 'experimental',
  capabilities: { toolExecution: true, questions: 'native', planMode: false, delegation: true, browser: true, safetyHooks: 'advisory' },

  globalRoot: '.gemini/antigravity-cli/skills/gstack',
  localSkillRoot: '.agents/skills/gstack',
  // Render output only. .agents is Codex's render tree, and .gemini is Gemini
  // CLI's workspace directory.
  hostSubdir: '.agy',

  // Antigravity reads name and description only; name defaults to the
  // directory, and the CLI turns each name into a slash command, so names
  // match their gstack-<skill> directories instead of shadowing /plan-style
  // built-ins. 1024 is the Agent Skills description limit.
  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'error',
    nameMatchesDirectory: true,
  },

  // Literal ~/.gemini/antigravity-cli paths (the Copilot model) so skills
  // without the preamble still resolve; .source-path (written by setup) lets
  // /gstack-upgrade find the checkout behind the runtime root.
  pathRewrites: [
    { from: 'if [ -d "$HOME/.claude/skills/gstack/.git" ]', to: 'if [ -d "$(cat "$HOME/.gemini/antigravity-cli/skills/gstack/.source-path" 2>/dev/null)/.git" ]' },
    { from: 'INSTALL_DIR="$HOME/.claude/skills/gstack"', to: 'INSTALL_DIR="$(cat "$HOME/.gemini/antigravity-cli/skills/gstack/.source-path")"' },
    { from: '$HOME/.claude/skills/gstack', to: '$HOME/.gemini/antigravity-cli/skills/gstack' },
    { from: '~/.claude/skills/gstack', to: '~/.gemini/antigravity-cli/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.agents/skills/gstack' },
    { from: '.claude/skills/review', to: '.agents/skills/gstack/review' },
    { from: '.claude/skills', to: '.agents/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: preambleToolGlossary(ANTIGRAVITY_TOOL_GLOSSARY),

  suppressedResolvers: ['REVIEW_ARMY', ...GBRAIN_RESOLVERS],

  runtimeRoot: {
    globalSymlinks: ['bin', 'lib', 'browse/dist', 'browse/bin', 'design/dist', 'make-pdf/dist', 'freeze/bin', 'careful/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },
});

export default agy;
