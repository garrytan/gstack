import { defineHost } from './define-host';

const claude = defineHost({
  name: 'claude',
  displayName: 'Claude Code',

  usesEnvVars: false,  // primary host — literal ~ paths, no $GSTACK_ROOT env vars

  frontmatter: {
    mode: 'denylist',
    stripFields: ['sensitive', 'voice-triggers'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['claude'],  // the /claude outside-voice skill is for non-Claude hosts; /codex stays (it IS a Claude skill wrapping codex exec)
  },

  pathRewrites: [],  // Claude is the primary host — no rewrites needed
  toolRewrites: {},

  install: {
    linkingStrategy: 'real-dir-symlink',
  },

  coAuthorTrailer: 'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>',
  learningsMode: 'full',
});

export default claude;
