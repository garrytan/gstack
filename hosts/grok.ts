import { defineHost, CROSS_MODEL_RESOLVERS, GBRAIN_RESOLVERS } from './define-host';

const grok = defineHost({
  name: 'grok',
  displayName: 'Grok Build',

  // The derived defaults are already correct: Grok reads global skills from
  // ~/.grok/skills, so globalRoot/.grok/skills/gstack and the standard
  // `.claude/skills` → `.grok/skills` rewrite both land in the right place.

  extraPathRewrites: [
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  // Grok's built-in tool names (README "Built-in Tools" table). Note there is
  // no separate create-file tool — search_replace covers both writes and
  // edits, and list_dir is the closest thing to a glob.
  toolRewrites: {
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'use the search_replace tool',
    'use the Read tool': 'use the read_file tool',
    'use the Edit tool': 'use the search_replace tool',
    'use the Agent tool': 'use the task tool',
    'use the Grep tool': 'use the grep_search tool',
    'use the Glob tool': 'use the list_dir tool',
    'the Bash tool': 'the bash tool',
    'the Read tool': 'the read_file tool',
    'the Write tool': 'the search_replace tool',
    'the Edit tool': 'the search_replace tool',
  },

  // Grok cannot shell out to Codex, so the cross-model resolvers never apply.
  suppressedResolvers: [...CROSS_MODEL_RESOLVERS, ...GBRAIN_RESOLVERS],
});

export default grok;
