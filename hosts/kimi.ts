import type { HostConfig } from '../scripts/host-config';

const kimi: HostConfig = {
  name: 'kimi',
  displayName: 'Kimi Code',
  cliCommand: 'kimi',
  cliAliases: [],

  globalRoot: '.kimi-code/skills/gstack',
  localSkillRoot: '.kimi-code/skills/gstack',
  hostSubdir: '.kimi-code',
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
    { from: '~/.claude/skills/gstack', to: '~/.kimi-code/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.kimi-code/skills/gstack' },
    { from: '.claude/skills', to: '.kimi-code/skills' },
    { from: '~/.config/opencode/skills/gstack', to: '~/.kimi-code/skills/gstack' },
    { from: '.config/opencode/skills/gstack', to: '.kimi-code/skills/gstack' },
    { from: '~/.agents/skills/gstack', to: '~/.kimi-code/skills/gstack' },
    { from: '.agents/skills/gstack', to: '.kimi-code/skills/gstack' },
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

export default kimi;
