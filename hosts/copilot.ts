import type { HostConfig } from '../scripts/host-config';
import opencode from './opencode';

const copilot: HostConfig = {
  ...opencode,
  name: 'copilot',
  displayName: 'GitHub Copilot CLI',
  cliCommand: 'gh',
  cliAliases: [],

  globalRoot: '.copilot/skills/gstack',
  localSkillRoot: '.copilot/skills/gstack',
  hostSubdir: '.copilot',

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.copilot/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.copilot/skills/gstack' },
    { from: '.claude/skills', to: '.copilot/skills' },
  ],
};

export default copilot;
