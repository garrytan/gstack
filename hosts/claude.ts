import type { HostConfig } from '../scripts/host-config';

const claude: HostConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  cliCommand: 'claude',
  cliAliases: [],

  globalRoot: '.claude/skills/gstack',
  localSkillRoot: '.claude/skills/gstack',
  hostSubdir: '.claude',
  usesEnvVars: false,

  frontmatter: {
    mode: 'denylist',
    stripFields: ['sensitive', 'voice-triggers'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: [],
  },

  pathRewrites: [],  // Claude is the primary host — no rewrites needed
  toolRewrites: {},
  suppressedResolvers: ['GBRAIN_CONTEXT_LOAD', 'GBRAIN_SAVE_RESULTS'],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: true,
    linkingStrategy: 'real-dir-symlink',
  },

  coAuthorTrailer: 'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>',
  learningsMode: 'full',
};

export default claude;
