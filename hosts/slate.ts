import type { HostConfig } from '../scripts/host-config';

const slate: HostConfig = {
  name: 'slate',
  displayName: 'Slate',
  cliCommand: 'slate',
  cliAliases: [],

  globalRoot: '.slate/skills/nstack',
  localSkillRoot: '.slate/skills/nstack',
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
    { from: '~/.claude/skills/nstack', to: '~/.slate/skills/nstack' },
    { from: '.claude/skills/nstack', to: '.slate/skills/nstack' },
    { from: '.claude/skills', to: '.slate/skills' },
  ],

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

  learningsMode: 'basic',
};

export default slate;
