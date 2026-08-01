import type { HostConfig } from '../scripts/host-config';

const claude: HostConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  cliCommand: 'claude',
  cliAliases: [],

  globalRoot: '.claude/skills/gstack',
  localSkillRoot: '.claude/skills/gstack',
  hostSubdir: '.claude',
  usesEnvVars: true,

  frontmatter: {
    mode: 'denylist',
    stripFields: ['sensitive', 'voice-triggers'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['claude'],  // Claude outside-voice skill is for non-Claude hosts
  },

  // Skill bodies resolve runtime assets through the preamble-defined root.
  // Frontmatter is deliberately excluded from these rewrites because hooks run
  // before the preamble and cannot use $GSTACK_ROOT (see #1871 / #1882).
  pathRewrites: [
    { from: '$HOME/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    // Tilde paths are necessarily unquoted in source templates. Quote the
    // replacement so renamed installs containing whitespace remain executable.
    { from: '~/.claude/skills/gstack', to: '"$GSTACK_ROOT"' },
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
    prefixable: true,
    linkingStrategy: 'real-dir-symlink',
  },

  coAuthorTrailer: 'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>',
  learningsMode: 'full',
};

export default claude;
