import type { HostConfig } from '../scripts/host-config';

const antigravity: HostConfig = {
  name: 'antigravity',
  displayName: 'Antigravity',
  cliCommand: 'agy',
  cliAliases: [],

  globalRoot: '.gemini/antigravity-cli/plugins/gstack/skills/gstack',
  localSkillRoot: '.antigravity/skills/gstack',
  hostSubdir: '.antigravity',
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
    { from: '~/.claude/skills/gstack', to: '~/.gemini/antigravity-cli/plugins/gstack/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.antigravity/skills/gstack' },
    { from: '.claude/skills', to: '.antigravity/skills' },
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

export default antigravity;
