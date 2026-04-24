import type { HostConfig } from '../scripts/host-config';
import openclaw from './openclaw';

const claw: HostConfig = {
  ...openclaw,
  name: 'claw',
  displayName: 'Claw Code',
  cliCommand: 'claw',
  cliAliases: [],
  globalRoot: '.claw/skills/gstack',
  localSkillRoot: '.claw/skills/gstack',
  hostSubdir: 'claw',
  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.claw/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.claw/skills/gstack' },
    { from: '.claude/skills', to: '.claw/skills' },
    { from: 'CLAUDE.md', to: 'CLAW.md' },
  ],
  coAuthorTrailer: 'Co-Authored-By: Claw Code <agent@claw.ai>',
};

export default claw;
