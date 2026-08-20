import { defineHost, CROSS_MODEL_RESOLVERS, EXEC_STYLE_TOOL_REWRITES } from './define-host';

/**
 * GBrain host config.
 * Compatible with GBrain >= v0.10.0 (doctor --fast --json, search CLI, entity enrichment).
 * When updating, check INSTALL_FOR_AGENTS.md in the GBrain repo for breaking changes.
 */
const gbrain = defineHost({
  name: 'gbrain',
  displayName: 'GBrain',

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description', 'triggers'],
    descriptionLimit: null,
  },

  extraPathRewrites: [
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: { ...EXEC_STYLE_TOOL_REWRITES },

  // GBrain gets brain-aware resolvers. All other hosts suppress these.
  suppressedResolvers: [
    ...CROSS_MODEL_RESOLVERS,
    // NOTE: GBRAIN_CONTEXT_LOAD and GBRAIN_SAVE_RESULTS are NOT suppressed here.
    // GBrain is the only host that gets brain-first lookup and save-to-brain behavior.
  ],

  coAuthorTrailer: 'Co-Authored-By: GBrain Agent <agent@gbrain.dev>',
});

export default gbrain;
