import { defineHost, CROSS_MODEL_RESOLVERS, GBRAIN_RESOLVERS, EXEC_STYLE_TOOL_REWRITES } from './define-host';

const openclaw = defineHost({
  name: 'openclaw',
  displayName: 'OpenClaw',
  tier: 'experimental',
  capabilities: { toolExecution: true, questions: 'prose', planMode: false, delegation: true, browser: true, safetyHooks: 'advisory' },

  extraPathRewrites: [
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: { ...EXEC_STYLE_TOOL_REWRITES },

  // Suppress Claude-specific preamble sections that don't apply to OpenClaw
  suppressedResolvers: [...CROSS_MODEL_RESOLVERS, ...GBRAIN_RESOLVERS],

  // ./setup --host openclaw (and setup run inside OpenClaw) registers through
  // gstack-harness: the task skills plus one gstack router skill for the rest in
  // $OPENCLAW_STATE_DIR/skills (hybrid), or --skills router|all. OpenClaw's ACP
  // route (docs/OPENCLAW.md) stays.
  install: {
    linkingStrategy: 'symlink-generated',
    registration: 'harness',
  },

  coAuthorTrailer: 'Co-Authored-By: OpenClaw Agent <agent@openclaw.ai>',
});

export default openclaw;
