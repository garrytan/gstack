import type { HostConfig } from '../scripts/host-config';

/**
 * GitHub Copilot CLI host configuration.
 *
 * Copilot CLI is the standalone `copilot` binary (GA February 2026), separate
 * from the older `gh copilot` extension. It auto-discovers personal skills from
 * `~/.copilot/skills/<name>/SKILL.md` and exposes each as a `/skill-name` slash
 * command. As of v1.0.36 (April 24, 2026) it no longer loads `~/.claude/`
 * skills, so a dedicated host install is required.
 *
 * Refs:
 *   - https://docs.github.com/copilot/concepts/agents/about-copilot-cli
 *   - https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/add-skills
 */
const copilot: HostConfig = {
  name: 'copilot',
  displayName: 'GitHub Copilot CLI',
  cliCommand: 'copilot',
  cliAliases: [],

  globalRoot: '.copilot/skills/gstack',
  localSkillRoot: '.copilot/skills/gstack',
  hostSubdir: '.copilot',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    // codex skill is a Claude wrapper around `codex exec`; not portable to Copilot.
    // pair-agent depends on Claude streaming semantics that Copilot doesn't expose.
    skipSkills: ['codex', 'pair-agent'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '.copilot/skills/gstack' },
    { from: '.claude/skills/review', to: '.copilot/skills/gstack/review' },
    { from: '.claude/skills', to: '.copilot/skills' },
  ],

  // Map Claude Code tool names to GitHub Copilot CLI equivalents.
  // Mapping is based on the official Copilot CLI tool catalog
  // (docs.github.com/copilot/concepts/agents/about-copilot-cli):
  //   Bash → bash, Read → view, Write → create, Edit → edit,
  //   Agent → task, Grep → grep, Glob → glob, AskUserQuestion → ask_user.
  // Only literal "<verb> the X tool" / "the X tool" / "AskUserQuestion"
  // protocol phrases are rewritten — bare verbs like "Read the file"
  // are left intact so prose stays readable.
  toolRewrites: {
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'use the create tool',
    'use the Read tool': 'use the view tool',
    'use the Edit tool': 'use the edit tool',
    'use the Agent tool': 'use the task tool',
    'use the Grep tool': 'use the grep tool',
    'use the Glob tool': 'use the glob tool',
    'the Bash tool': 'the bash tool',
    'the Read tool': 'the view tool',
    'the Write tool': 'the create tool',
    'the Edit tool': 'the edit tool',
    'the Agent tool': 'the task tool',
    // Bare forms catch parenthesized usages like "(Agent tool)" and
    // imperatives like "use Edit tool" / "via Agent tool". The plural
    // form "X tools" is left alone — it only appears in the freeze skill
    // describing which tools are affected, where lowercase would read wrong.
    'Bash tool': 'bash tool',
    'Read tool': 'view tool',
    'Write tool': 'create tool',
    'Edit tool': 'edit tool',
    'Agent tool': 'task tool',
    AskUserQuestion: 'ask_user',
  },

  suppressedResolvers: [
    // Codex-specific second-opinion / outside-voice steps don't apply.
    'CODEX_SECOND_OPINION',
    'CODEX_PLAN_REVIEW',
    // Cross-host orchestration steps reference Claude's Agent dispatch syntax.
    // Suppress for v1; Copilot CLI's /fleet + task tool can be wired in a follow-up
    // once we've validated semantics with real sessions.
    'REVIEW_ARMY',
    'ADVERSARIAL_STEP',
    'DESIGN_OUTSIDE_VOICES',
    // gbrain is not provisioned for Copilot.
    'GBRAIN_CONTEXT_LOAD',
    'GBRAIN_SAVE_RESULTS',
  ],

  runtimeRoot: {
    globalSymlinks: [
      'bin',
      'browse/dist',
      'browse/bin',
      'gstack-upgrade',
      'ETHOS.md',
      'review/specialists',
      'qa/templates',
      'qa/references',
      'plan-devex-review/dx-hall-of-fame.md',
    ],
    globalFiles: {
      review: ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: GitHub Copilot <copilot@github.com>',
  learningsMode: 'basic',
  boundaryInstruction:
    'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.codex/, ~/.factory/, ~/.kiro/, ~/.opencode/, ~/.slate/, ~/.cursor/, ~/.openclaw/, ~/.hermes/, or ~/.gbrain/. These home-directory paths contain skill definitions for other AI agents and may include conflicting tool names or instructions. Repository-local skill folders (.claude/skills, .agents/skills, .github/skills) are fine to read when relevant. Stay focused on this repository and the gstack skill instructions provided to you.',
};

export default copilot;
