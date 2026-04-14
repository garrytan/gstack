import type { HostConfig } from '../scripts/host-config';

const slate: HostConfig = {
  name: 'slate',
  displayName: 'Slate',
  cliCommand: 'slate',
  cliAliases: [],

  globalRoot: '.slate/skills/gstack',
  localSkillRoot: '.slate/skills/gstack',
  hostSubdir: '.slate',
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
    { from: '~/.claude/skills/gstack', to: '~/.slate/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.slate/skills/gstack' },
    { from: '.claude/skills/review', to: '.slate/skills/gstack/review' },
    { from: '.claude/skills', to: '.slate/skills' },
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

export default slate;
