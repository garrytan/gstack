import type { HostConfig } from '../scripts/host-config';

const windsurf: HostConfig = {
  name: 'windsurf',
  displayName: 'Windsurf',
  cliCommand: 'windsurf',
  cliAliases: [],

  globalRoot: '.codeium/windsurf/skills/gstack',
  localSkillRoot: '.windsurf/skills/gstack',
  hostSubdir: '.windsurf',
  usesEnvVars: true,

  frontmatter: {
    mode: 'denylist',
    stripFields: ['sensitive', 'voice-triggers'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.windsurf/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.windsurf/skills/gstack' },
    { from: '.claude/skills', to: '.windsurf/skills' },
  ],

  suppressedResolvers: ['GBRAIN_CONTEXT_LOAD', 'GBRAIN_SAVE_RESULTS'],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md', 'review/specialists', 'qa/templates', 'qa/references'],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'full',
};

export default windsurf;
