import type { HostConfig } from '../scripts/host-config';

const qoder: HostConfig = {
  name: 'qoder',
  displayName: 'Qoder',
  cliCommand: 'qoder',
  cliAliases: [],

  globalRoot: '.lingma/skills/gstack',
  localSkillRoot: '.lingma/skills/gstack',
  hostSubdir: '.lingma',
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
    { from: '~/.claude/skills/gstack', to: '~/.lingma/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.lingma/skills/gstack' },
    { from: '.claude/skills', to: '.lingma/skills' },
  ],

  suppressedResolvers: ['GBRAIN_CONTEXT_LOAD', 'GBRAIN_SAVE_RESULTS'],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'design/dist', 'gstack-upgrade', 'ETHOS.md', 'review/specialists', 'qa/templates', 'qa/references', 'plan-devex-review/dx-hall-of-fame.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
};

export default qoder;
