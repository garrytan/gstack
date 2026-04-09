import type { HostConfig } from '../scripts/host-config';

const opencode: HostConfig = {
  name: 'opencode',
  displayName: 'OpenCode',
  cliCommand: 'opencode',
  cliAliases: [],

  globalRoot: '.config/opencode/skills/nstack',
  localSkillRoot: '.opencode/skills/nstack',
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
    { from: '~/.claude/skills/nstack', to: '~/.config/opencode/skills/nstack' },
    { from: '.claude/skills/nstack', to: '.opencode/skills/nstack' },
    { from: '.claude/skills', to: '.opencode/skills' },
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

export default opencode;
