import type { HostConfig } from '../scripts/host-config';

const devin: HostConfig = {
  name: 'devin',
  displayName: 'Devin for Terminal',
  cliCommand: 'devin',
  cliAliases: [],

  globalRoot: '.config/devin/skills/gstack',
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
    { from: '~/.claude/skills/gstack', to: '~/.config/devin/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.devin/skills/gstack' },
    { from: '.claude/skills', to: '.devin/skills' },
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

export default devin;
