import type { HostConfig } from '../scripts/host-config';

const devin: HostConfig = {
  name: 'devin',
  displayName: 'Devin',
  cliCommand: 'devin',
  cliAliases: [],

  globalRoot: '.devin/skills/gstack',
  localSkillRoot: '.devin/skills/gstack',
  hostSubdir: '.devin',
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
    { from: '~/.claude/skills/gstack', to: '~/.devin/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.devin/skills/gstack' },
    { from: '.claude/skills', to: '.devin/skills' },
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

  coAuthorTrailer: 'Co-Authored-By: Devin <devin@cognition.ai>',
  learningsMode: 'basic',
};

export default devin;
