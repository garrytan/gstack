import type { HostConfig } from '../scripts/host-config';

const junie: HostConfig = {
  name: 'junie',
  displayName: 'Junie',
  cliCommand: 'junie',
  cliAliases: [],

  globalRoot: '.junie/skills/gstack',
  localSkillRoot: '.junie/skills/gstack',
  hostSubdir: '.junie',
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
    { from: '~/.claude/skills/gstack', to: '~/.junie/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.junie/skills/gstack' },
    { from: '.claude/skills', to: '.junie/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  suppressedResolvers: ['GBRAIN_CONTEXT_LOAD', 'GBRAIN_SAVE_RESULTS'],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
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

export default junie;
