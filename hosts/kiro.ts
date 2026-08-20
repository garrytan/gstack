import { defineHost } from './define-host';

const kiro = defineHost({
  name: 'kiro',
  displayName: 'Kiro',
  cliCommand: 'kiro-cli',

  // Beyond the standard .claude/* trio, Kiro also cleans up codex-style paths:
  // template prose that references ~/.codex/skills/gstack or .codex/skills
  // (e.g. cross-host examples) must land on Kiro's own paths.
  extraPathRewrites: [
    { from: '~/.codex/skills/gstack', to: '~/.kiro/skills/gstack' },
    { from: '.codex/skills', to: '.kiro/skills' },
  ],
});

export default kiro;
