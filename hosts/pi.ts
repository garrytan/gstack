import { defineHost, CROSS_MODEL_RESOLVERS, GBRAIN_RESOLVERS } from './define-host';

const pi = defineHost({
  name: 'pi',
  displayName: 'Pi',

  // Pi nests its agent state one level deeper than the host name: skills live
  // in ~/.pi/agent/skills, not ~/.pi/skills. The derived trio would point at
  // the wrong directory, so the rewrites are spelled out. hostSubdir stays
  // '.pi' purely as the (gitignored) generation output directory.
  globalRoot: '.pi/agent/skills/gstack',
  localSkillRoot: '.pi/agent/skills/gstack',
  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.pi/agent/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.pi/agent/skills/gstack' },
    { from: '.claude/skills', to: '.pi/agent/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  // Pi ships read/bash/edit/write as its core tools. It has no first-party
  // subagent or todo tool: `subagent` comes from the optional pi-subagents
  // package, and task tracking falls back to plan files or TODO.md.
  toolRewrites: {
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'use the write tool',
    'use the Read tool': 'use the read tool',
    'use the Edit tool': 'use the edit tool',
    'use the Agent tool': 'use the subagent tool (requires pi-subagents)',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
    'the Bash tool': 'the bash tool',
    'the Read tool': 'the read tool',
    'the Write tool': 'the write tool',
    'the Edit tool': 'the edit tool',
  },

  suppressedResolvers: [...CROSS_MODEL_RESOLVERS, ...GBRAIN_RESOLVERS],
});

export default pi;
