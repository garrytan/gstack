import { defineHost, CROSS_MODEL_RESOLVERS, GBRAIN_RESOLVERS, EXEC_STYLE_TOOL_REWRITES } from './define-host';

const openclaw = defineHost({
  name: 'openclaw',
  displayName: 'OpenClaw',

  extraPathRewrites: [
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: { ...EXEC_STYLE_TOOL_REWRITES },

  // Suppress Claude-specific preamble sections that don't apply to OpenClaw
  suppressedResolvers: [...CROSS_MODEL_RESOLVERS, ...GBRAIN_RESOLVERS],

  coAuthorTrailer: 'Co-Authored-By: OpenClaw Agent <agent@openclaw.ai>',
});

export default openclaw;
