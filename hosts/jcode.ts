import {
  defineHost,
  CROSS_MODEL_RESOLVERS,
  GBRAIN_RESOLVERS,
  preambleToolGlossary,
} from './define-host';

// Jcode CLI (https://github.com/1jehuang/jcode). Verified against jcode
// source: crates/jcode-base/src/skill.rs (frontmatter struct),
// crates/jcode-app-core/src/tool/skill.rs (discovery + list), docs/HOOKS.md.
// Facts:
//   - Global skills: ~/.jcode/skills/<name>/SKILL.md; project overlay:
//     ./.jcode/skills/<name>/SKILL.md (overlay wins on a name clash).
//     JCODE_HOME overrides the global dir.
//   - Frontmatter: only name, description, allowed-tools are parsed; the rest
//     is silently ignored, so we emit allowlist name+description only.
//   - No per-skill hooks and no plan mode; hooks are global
//     (~/.jcode/config.toml [hooks]). Safety skills are advisory.
//   - No AskUserQuestion tool; questions are plain text.
//   - CLAUDE.md is not read as instructions; AGENTS.md is.
//   - Outside review (claude/codex CLI shell-outs) has no jcode equivalent,
//     so all cross-model resolvers are suppressed.
const JCODE_TOOL_GLOSSARY = '**Jcode tool names:** `AskUserQuestion` means: ask the user in plain text and wait for the answer; there is no structured question tool and no `mcp__*__AskUserQuestion` variant. The Bash tool means `bash`, the Read tool `read`, the Write tool `write`, the Edit tool `edit`, Grep `agentgrep`, Glob `glob`, WebSearch `websearch`, WebFetch `webfetch`, and the Agent tool `subagent` (`swarm` for parallel workers). When a step says to call `ExitPlanMode`, tell the user the plan is ready and wait — jcode has no plan mode. There is no Skill tool: a skill is invoked as `/gstack-<name>`, or by reading its SKILL.md with `read`.';

const jcode = defineHost({
  name: 'jcode',
  displayName: 'Jcode CLI',
  tier: 'experimental',
  capabilities: {
    toolExecution: true,
    questions: 'prose',
    planMode: false,
    delegation: true,
    browser: true,
    safetyHooks: 'advisory',
  },

  // Default globalRoot (`.jcode/skills/gstack`) and localSkillRoot
  // (`.jcode/skills/gstack`, jcode's project overlay) are already right.
  // Render output only: `.jcode` is jcode's own workspace directory (project
  // overlay), so a render there would be loaded as live project skills in this
  // repo. The render dir mirrors Gemini's `.gemini-cli` separation.
  hostSubdir: '.jcode-render',

  // jcode indexes skills by frontmatter name and a project overlay wins on a
  // name clash, so names match their gstack-<skill> directories to avoid
  // shadowing the user's own skills. No description limit in jcode.
  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    nameMatchesDirectory: true,
  },

  // Literal ~/.jcode paths (the agy/gemini model) so skills without the
  // preamble still resolve; .source-path (written by setup) lets
  // /gstack-upgrade find the checkout behind the runtime root.
  pathRewrites: [
    { from: 'if [ -d "$HOME/.claude/skills/gstack/.git" ]', to: 'if [ -d "$(cat "$HOME/.jcode/skills/gstack/.source-path" 2>/dev/null)/.git" ]' },
    { from: 'INSTALL_DIR="$HOME/.claude/skills/gstack"', to: 'INSTALL_DIR="$(cat "$HOME/.jcode/skills/gstack/.source-path")"' },
    { from: '$HOME/.claude/skills/gstack', to: '$HOME/.jcode/skills/gstack' },
    { from: '~/.claude/skills/gstack', to: '~/.jcode/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.jcode/skills/gstack' },
    { from: '.claude/skills/review', to: '.jcode/skills/gstack/review' },
    { from: '.claude/skills', to: '.jcode/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: preambleToolGlossary(JCODE_TOOL_GLOSSARY),

  // No claude/codex CLI under jcode: suppress all cross-model second-opinion
  // resolvers (the OpenClaw/Hermes model) plus the GBrain pair.
  suppressedResolvers: [...CROSS_MODEL_RESOLVERS, ...GBRAIN_RESOLVERS],
});

export default jcode;
