import type { HostConfig } from '../scripts/host-config';

const agy: HostConfig = {
  name: 'agy',
  displayName: 'Antigravity',
  cliCommand: 'agy',
  cliAliases: [],

  globalRoot: '.gemini/config/plugins/gstack/skills',
  localSkillRoot: '.gemini/config/plugins/gstack/skills',
  hostSubdir: '.gemini/config/plugins/gstack',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: [
      'name',
      'preamble-tier',
      'version',
      'description',
      'allowed-tools',
      'triggers',
      'hooks',
      'gbrain',
    ],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '.gemini/config/plugins/gstack/skills' },
    { from: '.claude/skills', to: '.gemini/config/plugins/gstack' },
  ],

  toolRewrites: {},

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

export default agy;
