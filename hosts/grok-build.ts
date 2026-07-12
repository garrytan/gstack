import type { HostConfig } from '../scripts/host-config';

/**
 * Grok Build (xAI) host — based on community PR #2028 (adamouabakar),
 * aligned with cursor/factory host patterns and Grok skill discovery.
 *
 * Skills generate into <repo>/.grok/skills/gstack-* and install under
 * ~/.grok/skills/ (flat skill packages + runtime root at ~/.grok/skills/gstack).
 *
 * Grok discovers user skills from ~/.grok/skills/<name>/SKILL.md.
 * Frontmatter `name:` stays unprefixed (browse, ship, …) so slash commands
 * remain /browse, /ship, etc. Directory names use gstack- prefix (external hosts).
 */
const grokBuild: HostConfig = {
  name: 'grok-build',
  displayName: 'Grok Build',
  cliCommand: 'grok',
  cliAliases: ['grok-build'],

  // Relative to $HOME for global install path docs / preamble
  globalRoot: '.grok/skills/gstack',
  // Project-local runtime root (optional team mode)
  localSkillRoot: '.grok/skills/gstack',
  // Gitignored generated skill docs live here
  hostSubdir: '.grok',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    // Keep triggers so Grok model-invocation routing still works
    keepFields: ['name', 'description', 'triggers', 'allowed-tools'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    // Upstream convention: /codex skill is a Claude↔Codex bridge; all external
    // hosts skip it (host-config.test.ts). Grok users already have the openai-codex
    // plugin; keep /claude as an optional outside-voice skill.
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '.grok/skills/gstack' },
    { from: '.claude/skills/review', to: '.grok/skills/gstack/review' },
    { from: '.claude/skills', to: '.grok/skills' },
    { from: '~/.claude/skills', to: '~/.grok/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
    // Defense-in-depth if a Claude model overlay ever slips through (U3 / KTD6)
    { from: 'MODEL_OVERLAY: claude', to: 'MODEL_OVERLAY: none' },
    { from: 'use the Skill tool', to: 'invoke the skill via slash command or skill load' },
  ],

  toolRewrites: {
    'use the Bash tool': 'run this command in the shell',
    'use the Write tool': 'create this file',
    'use the Read tool': 'read the file',
    'use the Edit tool': 'edit the file',
    'use the Agent tool': 'dispatch a subagent',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
    'use the Skill tool': 'invoke the skill via slash command or skill load',
    AskUserQuestion: 'ask_user_question',
    ExitPlanMode: 'exit_plan_mode',
  },

  // Suppress Claude-only outside-voice orchestration that assumes Claude can
  // spawn Codex as itself. Keep plan/review skills; they still run on Grok.
  suppressedResolvers: [
    'GBRAIN_CONTEXT_LOAD',
    'GBRAIN_SAVE_RESULTS',
  ],

  // Thin runtime root: every asset skills resolve via $GSTACK_ROOT (R1 / U1).
  // Dual-write with setup create_grok_runtime_root — keep lists in sync.
  runtimeRoot: {
    globalSymlinks: [
      'bin',
      'browse/dist',
      'browse/bin',
      'browse/src',
      'design/dist',
      'make-pdf/dist',
      'extension',
      'scripts',
      'review/specialists',
      'gstack-upgrade',
      'ETHOS.md',
    ],
    globalFiles: {
      review: [
        'checklist.md',
        'TODOS-format.md',
        'design-checklist.md',
        'greptile-triage.md',
      ],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
  boundaryInstruction:
    'IMPORTANT: Prefer ~/.grok/skills/gstack and $GSTACK_ROOT over ~/.claude/skills/gstack. ' +
    'Do not assume Claude Code tools (TodoWrite, Skill tool, Claude-in-Chrome MCP). ' +
    'Use Grok shell/read/edit/web tools and ask_user_question. Prefer /browse over browser MCPs.',
};

export default grokBuild;
