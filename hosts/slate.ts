import type { HostConfig } from '../scripts/host-config';

const slate: HostConfig = {
  name: 'slate',
  displayName: 'Slate',
  cliCommand: 'slate',
  cliAliases: [],

  globalRoot: '.slate/skills/jstack',
  localSkillRoot: '.slate/skills/jstack',
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
    { from: '~/.claude/skills/jstack', to: '~/.slate/skills/jstack' },
    { from: '.claude/skills/jstack', to: '.slate/skills/jstack' },
    { from: '.claude/skills', to: '.slate/skills' },
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

export default slate;
