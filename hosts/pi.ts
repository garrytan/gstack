import type { HostConfig } from '../scripts/host-config';

const pi: HostConfig = {
  name: 'pi',
  displayName: 'Pi',
  cliCommand: 'pi',
  cliAliases: [],

  globalRoot: '.pi/agent/skills/gstack',
  localSkillRoot: '.pi/skills/gstack',
  hostSubdir: '.pi',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'truncate',
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.pi/agent/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.pi/agent/skills/gstack' },
    { from: '.claude/skills', to: '.pi/agent/skills' },
    // Identity rewrites
    { from: 'Claude Code', to: 'Pi' },
    { from: 'claude code', to: 'Pi' },
    { from: 'this Pi window', to: 'this Pi session' },
    // Project config file
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  toolRewrites: {
    'AskUserQuestion': 'ask_user',
    'WebSearch': 'web_search',
    'use the Agent tool': 'use a subagent',
    'the Agent tool': 'the subagent tool',
    'via Agent tool': 'via subagent',
    'Agent tool with': 'subagent tool with',
    'Agent tool,': 'subagent tool,',
    "Claude Code's Grep tool": "Pi's grep tool",
    'Invoke the Skill tool': 'Read the skill file',
    'via the Skill tool': 'by reading the skill file',
    'ExitPlanMode': '/plan (toggle off)',
    'Agent tool calls': 'subagent calls',
    'foreground Agent tool': 'foreground subagent',
    'subagent_type: "general-purpose"': 'agent: "worker"',
  },

  // Do NOT suppress — GBrain resolvers handle not-installed gracefully.
  // Follow the Hermes pattern: if GBrain is available, features activate.
  suppressedResolvers: [],

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

  learningsMode: 'basic',
};

export default pi;
