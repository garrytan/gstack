import type { HostConfig } from '../scripts/host-config';

const cursor: HostConfig = {
  name: 'cursor',
  displayName: 'Cursor',
  cliCommand: 'cursor',
  cliAliases: [],

  globalRoot: '.cursor/skills/gstack',
  localSkillRoot: '.cursor/skills/gstack',
  hostSubdir: '.cursor',
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
    { from: '~/.claude/skills/gstack', to: '~/.cursor/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.cursor/skills/gstack' },
    { from: '.claude/skills/review', to: '.cursor/skills/gstack/review' },
    { from: '.claude/skills', to: '.cursor/skills' },
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

export default cursor;
