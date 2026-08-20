import { defineHost, CROSS_MODEL_RESOLVERS } from './define-host';

const hermes = defineHost({
  name: 'hermes',
  displayName: 'Hermes',

  extraPathRewrites: [
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: {
    'use the Bash tool': 'use the terminal tool',
    'use the Write tool': 'use the patch tool',
    'use the Read tool': 'use the read_file tool',
    'use the Edit tool': 'use the patch tool',
    'use the Agent tool': 'use delegate_task',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
    'the Bash tool': 'the terminal tool',
    'the Read tool': 'the read_file tool',
    'the Write tool': 'the patch tool',
    'the Edit tool': 'the patch tool',
  },

  suppressedResolvers: [
    ...CROSS_MODEL_RESOLVERS,
    // GBRAIN_CONTEXT_LOAD and GBRAIN_SAVE_RESULTS are NOT suppressed.
    // The resolvers handle GBrain-not-installed gracefully ("proceed without brain context").
    // If Hermes has GBrain as a mod, brain features activate automatically.
  ],

  coAuthorTrailer: 'Co-Authored-By: Hermes Agent <agent@nousresearch.com>',
});

export default hermes;
