import { defineHost, CROSS_MODEL_RESOLVERS, preambleToolGlossary } from './define-host';

const hermes = defineHost({
  name: 'hermes',
  displayName: 'Hermes',
  tier: 'experimental',
  capabilities: { toolExecution: true, questions: 'native', planMode: false, delegation: true, browser: true, safetyHooks: 'advisory' },

  // Hermes indexes skills by frontmatter name, first match wins (#2825). Its
  // skills index shows 57 chars of a description and "..." (agent/skill_utils.py
  // SKILL_PROMPT_DESC_LIMIT = 60), so each description leads with when to use it.
  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
    descriptionLead: 57,
    nameMatchesDirectory: true,
  },

  extraPathRewrites: [
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: {
    'use the Bash tool': 'use the terminal tool',
    'use the Write tool': 'use the patch tool',
    'use the Read tool': 'use the read_file tool',
    'use the Edit tool': 'use the patch tool',
    'use the Agent tool': 'use delegate_task',
    "Claude Code's Agent tool": 'delegate_task',
    'the Agent tool': 'delegate_task',
    'Agent tool': 'delegate_task',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
    'the Bash tool': 'the terminal tool',
    'the Read tool': 'the read_file tool',
    'the Write tool': 'the patch tool',
    'the Edit tool': 'the patch tool',
    // #2015: Hermes asks through clarify.
    ...preambleToolGlossary('**Hermes tool names:** `AskUserQuestion` means your `clarify` tool (one question per call, options as choices); there is no `mcp__*__AskUserQuestion` variant.'),
  },

  suppressedResolvers: [
    ...CROSS_MODEL_RESOLVERS,
    // GBRAIN_CONTEXT_LOAD and GBRAIN_SAVE_RESULTS are NOT suppressed.
    // The resolvers handle GBrain-not-installed gracefully ("proceed without brain context").
    // If Hermes has GBrain as a mod, brain features activate automatically.
  ],

  // ./setup --host hermes (and setup run inside Hermes) registers every skill
  // through gstack-harness into $HERMES_HOME/skills/gstack (one category).
  install: {
    linkingStrategy: 'symlink-generated',
    registration: 'harness',
  },

  coAuthorTrailer: 'Co-Authored-By: Hermes Agent <agent@nousresearch.com>',
});

export default hermes;
