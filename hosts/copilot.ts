import type { HostConfig } from '../scripts/host-config';

/**
 * GitHub documents one Agent Skills contract for Copilot CLI and the Copilot app:
 * personal skills live in ~/.copilot/skills and repository skills in .github/skills.
 * Keep generated staging under .copilot/ so Copilot never collides with Codex's
 * .agents/skills output.
 */
const copilot: HostConfig = {
  name: 'copilot',
  displayName: 'GitHub Copilot CLI and app',
  cliCommand: 'copilot',
  cliAliases: [],
  supportedSurfaces: ['cli', 'app'],

  globalRoot: '.copilot/skills/gstack',
  globalRootEnv: 'COPILOT_HOME',
  localSkillRoot: '.github/skills/gstack',
  hostSubdir: '.copilot',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    namePrefix: 'gstack-',
    nameLimit: 64,
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'error',
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '${HOME}/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    {
      from: '$HOME/.claude/skills/gstack/.git',
      to: '$(cat "$GSTACK_ROOT/.source-path")/.git',
    },
    {
      from: 'INSTALL_DIR="$HOME/.claude/skills/gstack"',
      to: 'INSTALL_DIR="$(cat "$GSTACK_ROOT/.source-path")"',
    },
    { from: '$HOME/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/review', to: '$GSTACK_ROOT/review' },
    {
      from: '[ -f "$GSTACK_ROOT/VERSION" ] || [ -d "$GSTACK_ROOT/.git" ]',
      to: '[ -d "$GSTACK_ROOT/.git" ]',
    },
    { from: '\n./setup\n', to: '\n./setup --host copilot\n' },
    { from: '&& ./setup\n', to: '&& ./setup --host copilot\n' },
    { from: '.claude/skills', to: '.github/skills' },
    { from: '.agents/skills/gstack', to: '.github/skills/gstack' },
    { from: '.agents/skills', to: '.github/skills' },
  ],
  toolRewrites: {
    'AskUserQuestion': 'ask_user',
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'edit the file',
    'use the Read tool': 'use the view tool',
    'use the Edit tool': 'edit the file',
    'use the Agent tool': 'use the task tool',
    'use the Grep tool': 'search the repository',
    'use the Glob tool': 'find matching files',
    'the Bash tool': 'the bash tool',
    'the Write tool': 'file editing',
    'the Read tool': 'the view tool',
    'the Edit tool': 'file editing',
    'the Agent tool': 'the task tool',
    'the Grep tool': 'repository search',
    'the Glob tool': 'file matching',
  },

  // Copilot supports task and skill tools, so its same-host subagent orchestration
  // remains enabled. Only optional gbrain blocks are suppressed by default.
  suppressedResolvers: ['GBRAIN_CONTEXT_LOAD', 'GBRAIN_SAVE_RESULTS'],

  runtimeRoot: {
    globalSymlinks: [
      'bin',
      'browse/dist',
      'browse/bin',
      'design/dist',
      'make-pdf/dist',
      'design-html/vendor',
      'extension',
      'hosts',
      'lib',
      'scripts',
      'ios-qa/templates',
      'ios-qa/scripts',
      'ios-qa/daemon',
      'supabase',
      'VERSION',
      'CHANGELOG.md',
      'setup',
      'package.json',
      'bun.lock',
      'ETHOS.md',
      'office-hours/SKILL.md',
      'document-release/SKILL.md',
      'plan-ceo-review/SKILL.md',
      'plan-design-review/SKILL.md',
      'plan-devex-review/SKILL.md',
      'plan-eng-review/SKILL.md',
      'gstack-upgrade/SKILL.md',
      'gstack-upgrade/migrations',
      'review/specialists',
      'qa/templates',
      'qa/references',
      'plan-devex-review/dx-hall-of-fame.md',
    ],
    globalFiles: {
      review: ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },
  sidecar: {
    path: '.github/skills/gstack',
    symlinks: [
      'bin',
      'browse',
      'design',
      'make-pdf',
      'design-html',
      'extension',
      'hosts',
      'lib',
      'scripts',
      'gstack-upgrade',
      'ETHOS.md',
      'review',
      'qa',
      'plan-devex-review',
    ],
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: GitHub Copilot <copilot@github.com>',
  learningsMode: 'basic',
};

export default copilot;
