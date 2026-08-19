import { defineHost } from './define-host';

/**
 * Cursor host.
 *
 * The checked-in Cursor-native surface lives in `.cursor/skills/` (unprefixed
 * names), `.cursor/rules/`, and `.cursor/hooks.json`. Those files are generated
 * by `bun run gen:cursor-native` and are what Cursor Agent actually loads.
 *
 * `./setup --host cursor` still plants prefixed `gstack-*` skills under
 * `~/.cursor/skills/` for users who install gstack into an existing Cursor
 * workspace. Tool/path rewrites below keep that generated slice Cursor-shaped.
 */
const cursor = defineHost({
  name: 'cursor',
  displayName: 'Cursor',

  extraPathRewrites: [
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  toolRewrites: {
    'AskUserQuestion': 'AskQuestion',
    'use the Bash tool': 'use the Shell tool',
    'the Bash tool': 'the Shell tool',
    'use the Agent tool': 'use the Task tool',
    'the Agent tool': 'the Task tool',
    'ExitPlanMode': 'SwitchMode (target_mode_id: agent)',
    'invoke it via the Skill tool': 'read and follow the matching skill in .cursor/skills/',
    'Use the Skill tool': 'Read the matching skill in .cursor/skills/ and follow it',
    'via the Skill tool': 'by reading `.cursor/skills/<name>/SKILL.md`',
    'mcp__claude-in-chrome__': 'the browse binary (`$B`) — never Chrome MCP tools',
  },

  coAuthorTrailer: 'Co-Authored-By: Cursor <cursoragent@cursor.com>',
});

export default cursor;
