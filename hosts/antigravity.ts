import type { HostConfig } from '../scripts/host-config';

/**
 * Google Antigravity 2.0 host config.
 *
 * Supports:
 *   - Antigravity CLI (`agy` / `antigravity`)
 *   - Antigravity Desktop IDE (multi-agent subagent worktrees)
 *   - Antigravity Python SDK (cron/headless background agents)
 *
 * Path layout:
 *   Global install : ~/.antigravity/skills/gstack
 *   Repo-local     : .antigravity/skills/gstack
 *   Host subdir    : .antigravity
 *
 * NOTE on .agents/ collision: codex already owns hostSubdir='.agents'. Using
 * '.antigravity' keeps validateAllConfigs() happy and is the idiomatic pattern
 * for every host after claude/codex (see openclaw, hermes, gbrain, etc.).
 *
 * NOTE on 'gemini' alias: the `gemini` binary name is owned by @google/gemini-cli
 * (a separate product). It must NOT be registered here to avoid CLI resolution
 * collisions. Only 'agy' is a safe, unambiguous alias.
 *
 * NOTE on repo-local discovery: Antigravity Desktop IDE reads `.antigravity/skills/`
 * for repo-local skills by default (configurable via ANTIGRAVITY_SKILL_ROOT env var).
 * If a project team uses `.agents/skills/` exclusively, document a symlink:
 *   ln -s .antigravity/skills/gstack .agents/skills/gstack
 * or set ANTIGRAVITY_SKILL_ROOT=.agents/skills in the project's .env.
 * This is noted in the generated skill AGENTS.md preamble via the adapter.
 */
const antigravity: HostConfig = {
  name: 'antigravity',
  displayName: 'Google Antigravity',
  cliCommand: 'antigravity',
  cliAliases: ['agy'],

  globalRoot: '.antigravity/skills/gstack',
  localSkillRoot: '.antigravity/skills/gstack',
  hostSubdir: '.antigravity',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    // Keep only fields consumed by Antigravity's routing table.
    // 'version' + 'author' populate the IDE skill card metadata.
    // 'tools' lets the Desktop IDE pre-authorize tool calls per skill.
    // Keeping this list short prevents context-window bloat when the
    // multi-agent orchestrator loads all skill manifests simultaneously.
    keepFields: ['name', 'description', 'version', 'author'],
    renameFields: { 'allowed-tools': 'tools' },
    // 1024-char limit prevents any single skill description from dominating
    // the routing table context; 'truncate' avoids hard build failures on
    // edge cases while still surfacing an actionable warning in CI logs.
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'truncate',
  },

  generation: {
    generateMetadata: false,
    // 'codex' skill is a Claude wrapper around the codex exec binary — meaningless on Antigravity.
    // 'agy' skill is a Claude wrapper around the agy exec binary — skip self-referential loop.
    skipSkills: ['codex', 'agy'],
  },

  pathRewrites: [
    // Global root rewrites — must be ordered longest-match first
    { from: '~/.claude/skills/gstack', to: '~/.antigravity/skills/gstack' },
    { from: '.claude/skills/gstack',   to: '.antigravity/skills/gstack' },
    { from: '.claude/skills/review',   to: '.antigravity/skills/gstack/review' },
    { from: '.claude/skills',          to: '.antigravity/skills' },
    // Codex sidecar path (.agents is used by codex, not Antigravity)
    { from: '.agents/skills/gstack',   to: '.antigravity/skills/gstack' },
    { from: '.agents/skills',          to: '.antigravity/skills' },
    // Config file rewrites
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
    // Home dir path segment rewrites
    { from: '~/.claude/', to: '~/.antigravity/' },
    { from: '.claude/',   to: '.antigravity/' },
  ],

  toolRewrites: {
    // Bash / shell execution
    'use the Bash tool':   'use the execute_terminal_command tool',
    'use the Write tool':  'use the apply_file_modification tool',
    'use the Read tool':   'use the read_file_content tool',
    'use the Edit tool':   'use the apply_file_modification tool',
    'use the Agent tool':  'spawn a subagent task',
    'use the Grep tool':   'search for',
    'use the Glob tool':   'find files matching',
    // Bare noun references (appear in prose after "the X tool already ran" etc.)
    'the Bash tool':       'the execute_terminal_command tool',
    'the Read tool':       'the read_file_content tool',
    'the Write tool':      'the apply_file_modification tool',
    'the Edit tool':       'the apply_file_modification tool',
  },

  // Suppress Claude-specific cross-invocation resolvers that would generate
  // "run `codex …`" or "run `claude …`" instructions inside Antigravity sessions.
  suppressedResolvers: [
    'DESIGN_OUTSIDE_VOICES',  // design.ts — would emit "run codex" instructions
    'ADVERSARIAL_STEP',       // review.ts — would emit "run codex" instructions
    'CODEX_SECOND_OPINION',   // review.ts — Codex can't be invoked from Antigravity
    'CODEX_PLAN_REVIEW',      // review.ts — same
    'REVIEW_ARMY',            // review-army.ts — Claude orchestration, not applicable
    'GBRAIN_CONTEXT_LOAD',    // gbrain not integrated with Antigravity SDK
    'GBRAIN_SAVE_RESULTS',    // same
  ],

  runtimeRoot: {
    globalSymlinks: [
      'bin',
      'browse/dist',
      'browse/bin',
      'design/dist',
      'gstack-upgrade',
      'ETHOS.md',
      'review/specialists',
      'qa/templates',
      'qa/references',
    ],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: Google Antigravity <antigravity-agent@google.com>',
  learningsMode: 'basic',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or .agents/skills/. These are Claude Code or Codex skill definitions meant for a different AI system. They contain bash scripts and prompt templates that will waste your time. Ignore them completely. Stay focused on the repository code only.',

  // Adapter handles AskUserQuestion → request_user_input with headless-mode
  // conditional (ANTIGRAVITY_HEADLESS=1 → write to TODOS.md instead of blocking).
  adapter: 'scripts/host-adapters/antigravity-adapter.ts',
};

export default antigravity;
