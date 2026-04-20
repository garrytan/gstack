import type { HostConfig } from '../scripts/host-config';

const opencode: HostConfig = {
  name: 'opencode',
  displayName: 'OpenCode',
  cliCommand: 'opencode',
  cliAliases: [],

  globalRoot: '.config/opencode/skills/gstack',
  localSkillRoot: '.opencode/skills/gstack',
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
    { from: '~/.claude/skills/gstack', to: '~/.config/opencode/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.opencode/skills/gstack' },
    { from: '.claude/skills', to: '.opencode/skills' },
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

export default opencode;
