import type { HostConfig } from '../scripts/host-config';

const cursor: HostConfig = {
  name: 'cursor',
  displayName: 'Cursor',
  cliCommand: 'cursor',
  cliAliases: [],

  globalRoot: '.cursor/skills/jstack',
  localSkillRoot: '.cursor/skills/jstack',
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
    { from: '~/.claude/skills/jstack', to: '~/.cursor/skills/jstack' },
    { from: '.claude/skills/jstack', to: '.cursor/skills/jstack' },
    { from: '.claude/skills', to: '.cursor/skills' },
  ],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'jstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
};

export default cursor;
