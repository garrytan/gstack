import type { HostConfig } from '../scripts/host-config';

const opencode: HostConfig = {
  name: 'opencode',
  displayName: 'OpenCode',
  cliCommand: 'opencode',
  cliAliases: [],

  globalRoot: '.config/opencode/skills/gstack',
  localSkillRoot: '.opencode/skills/gstack',
  hostSubdir: '.opencode',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.config/opencode/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.opencode/skills/gstack' },
    { from: '.claude/skills/review', to: '.opencode/skills/gstack/review' },
    { from: '.claude/skills', to: '.opencode/skills' },
  ],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'design/dist', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
      'review/specialists': ['api-contract.md', 'data-migration.md', 'maintainability.md', 'performance.md', 'red-team.md', 'security.md', 'testing.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
    setupStrategy: 'generic',
  },

  learningsMode: 'basic',
};

export default opencode;
