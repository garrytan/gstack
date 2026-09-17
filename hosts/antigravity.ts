import { defineHost } from './define-host';

const antigravity = defineHost({
  name: 'antigravity',
  displayName: 'Google Antigravity',
  cliCommand: 'agy',
  cliAliases: ['agy'],
  defaultModel: 'gemini',

  globalRoot: '.gemini/config/skills/gstack',
  localSkillRoot: '.agents/skills/gstack',
  hostSubdir: '.gemini',

  extraPathRewrites: [
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
    { from: '~/.codex/skills/gstack', to: '~/.gemini/config/skills/gstack' },
    { from: '.codex/skills', to: '.agents/skills' },
  ],

  coAuthorTrailer: 'Co-Authored-By: Google Antigravity <antigravity@google.com>',
});

export default antigravity;
