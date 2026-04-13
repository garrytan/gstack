import type { HostConfig } from '../scripts/host-config';

const pi: HostConfig = {
  name: 'pi',
  displayName: 'Pi',
  cliCommand: 'pi',
  cliAliases: [],

  // Pi uses ~/.pi/agent/skills/ for global, .pi/skills/ for project-local
  globalRoot: '.pi/agent/skills/gstack',
  localSkillRoot: '.pi/skills/gstack',
  hostSubdir: '.pi',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,  // Agent Skills spec: max 1024 chars
    prefixName: true,  // Pi validates name: must match parent directory (gstack-review, etc.)
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],  // Codex skill wraps `codex exec` — Pi invokes codex directly
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.pi/agent/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.pi/skills/gstack' },
    { from: '.claude/skills/review', to: '.pi/skills/gstack/review' },
    { from: '.claude/skills', to: '.pi/skills' },
    // Boundary instructions: tell Codex to also avoid .pi/ dirs
    { from: 'under ~/.claude/, ~/.agents/, .pi/skills/, or agents/. These are Claude Code skill definitions', to: 'under ~/.claude/, ~/.agents/, ~/.pi/, .pi/skills/, or agents/. These are Pi / Claude Code skill definitions' },
    // Self-identity rewrites: Pi is the host, not Claude Code
    { from: 'this Claude Code window', to: 'this Pi window' },
    { from: 'using Claude Code as a force multiplier', to: 'using Pi as a force multiplier' },
    { from: "via Claude Code's Agent tool", to: 'via Pi tools' },
    { from: 'with Claude Code. The engineering barrier', to: 'with Pi. The engineering barrier' },
    { from: '\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n', to: '\n' },
    { from: 'Claude Code: N sessions', to: 'Pi: N sessions' },
  ],

  // Pi tool names are lowercase; remap Claude-style references
  toolRewrites: {
    'use the Bash tool': 'use the bash tool',
    'use the Read tool': 'use the read tool',
    'use the Write tool': 'use the write tool',
    'use the Edit tool': 'use the edit tool',
    'use the Agent tool': 'dispatch a subagent',
    'use the Grep tool': 'use bash with grep',
    'use the Glob tool': 'use bash with find',
    'AskUserQuestion': 'ask_user_question',
  },

  suppressedResolvers: [],  // Pi uses Claude Opus — same capabilities, nothing to suppress

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: Claude Opus 4.6 via Pi <noreply@anthropic.com>',
  learningsMode: 'full',  // Same model as Claude — full cross-project learnings
};

export default pi;
