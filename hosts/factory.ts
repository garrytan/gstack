import type { HostConfig } from '../scripts/host-config';

const factory: HostConfig = {
  name: 'factory',
  displayName: 'Factory Droid',
  cliCommand: 'droid',
  cliAliases: ['droid'],

  globalRoot: '.factory/skills/nstack',
  localSkillRoot: '.factory/skills/nstack',
  hostSubdir: '.factory',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description', 'user-invocable'],
    descriptionLimit: null,
    extraFields: {
      'user-invocable': true,
    },
    conditionalFields: [
      { if: { sensitive: true }, add: { 'disable-model-invocation': true } },
    ],
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],  // Codex skill is a Claude wrapper around codex exec
  },

  pathRewrites: [
    { from: '~/.claude/skills/nstack', to: '$NSTACK_ROOT' },
    { from: '.claude/skills/nstack', to: '.factory/skills/nstack' },
    { from: '.claude/skills/review', to: '.factory/skills/nstack/review' },
    { from: '.claude/skills', to: '.factory/skills' },
  ],
  toolRewrites: {
    'use the Bash tool': 'run this command',
    'use the Write tool': 'create this file',
    'use the Read tool': 'read the file',
    'use the Agent tool': 'dispatch a subagent',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
  },

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'nstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: Factory Droid <droid@users.noreply.github.com>',
  learningsMode: 'full',
};

export default factory;
