import { defineHost } from './define-host';

const factory = defineHost({
  name: 'factory',
  displayName: 'Factory Droid',
  cliCommand: 'droid',
  cliAliases: ['droid'],

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description', 'user-invocable'],
    descriptionLimit: null,
    extraFields: {
      'user-invocable': true,
    },
    conditionalFields: [
      { if: { sensitive: true }, add: { 'disable-model-invocation': true } },
    ],
  },

  // Non-mechanical rewrites: the global path becomes $GSTACK_ROOT (resolved by
  // the preamble env vars), plus an extra review-path rewrite the derived trio
  // doesn't cover.
  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '.factory/skills/gstack' },
    { from: '.claude/skills/review', to: '.factory/skills/gstack/review' },
    { from: '.claude/skills', to: '.factory/skills' },
  ],
  toolRewrites: {
    'use the Bash tool': 'run this command',
    'use the Write tool': 'create this file',
    'use the Read tool': 'read the file',
    'use the Agent tool': 'dispatch a subagent',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
  },

  coAuthorTrailer: 'Co-Authored-By: Factory Droid <droid@users.noreply.github.com>',
  learningsMode: 'full',
});

export default factory;
