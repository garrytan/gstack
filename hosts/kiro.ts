import type { HostConfig } from '../scripts/host-config';

const kiro: HostConfig = {
  name: 'kiro',
  displayName: 'Kiro',
  cliCommand: 'kiro-cli',
  cliAliases: [],

  globalRoot: '.kiro/skills/jstack',
  localSkillRoot: '.kiro/skills/jstack',
  hostSubdir: '.kiro',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],  // Codex skill is a Claude wrapper around codex exec
  },

  pathRewrites: [
    { from: '~/.claude/skills/jstack', to: '~/.kiro/skills/jstack' },
    { from: '.claude/skills/jstack', to: '.kiro/skills/jstack' },
    { from: '.claude/skills', to: '.kiro/skills' },
    { from: '~/.codex/skills/jstack', to: '~/.kiro/skills/jstack' },
    { from: '.codex/skills', to: '.kiro/skills' },
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

export default kiro;
