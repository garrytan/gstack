import type { HostConfig } from '../scripts/host-config';

const zed: HostConfig = {
  name: 'zed',
  displayName: 'Zed',
  cliCommand: 'zed',
  cliAliases: [],

  globalRoot: '.agents/skills/gstack',
  localSkillRoot: '.agents/skills/gstack',
  hostSubdir: '.zed',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'truncate',
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  maxFileBytes: 100 * 1024,

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.agents/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.agents/skills/gstack' },
    { from: '.claude/skills', to: '.agents/skills' },
  ],

  suppressedResolvers: ['GBRAIN_CONTEXT_LOAD', 'GBRAIN_SAVE_RESULTS'],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'design/dist', 'gstack-upgrade', 'ETHOS.md'],
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

export default zed;
