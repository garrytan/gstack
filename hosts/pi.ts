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
    descriptionLimitBehavior: 'warn',
    // Pi validates Agent Skills names against the parent directory. External
    // gstack skill directories are prefixed (gstack-ship), so emit that name.
    nameStrategy: 'external',
    conditionalFields: [
      { if: { sensitive: true }, add: { 'disable-model-invocation': true } },
    ],
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '~/.claude/skills/review', to: '$GSTACK_ROOT/review' },
    { from: '~/.claude/skills', to: '$GSTACK_ROOT/..' },
    { from: '.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/review', to: '$GSTACK_ROOT/review' },
    { from: '.claude/skills', to: '$GSTACK_ROOT/..' },
    { from: '$HOME/$GSTACK_ROOT', to: '$GSTACK_ROOT' },
    { from: '${HOME}/$GSTACK_ROOT', to: '$GSTACK_ROOT' },
    { from: '$_ROOT/$GSTACK_ROOT', to: '$GSTACK_ROOT' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  toolRewrites: {
    'invoke it via the Skill tool': 'invoke it with the matching /skill:gstack-* command',
    'invoke the Skill tool': 'send the matching /skill:gstack-* command',
    'via the Skill tool': 'with the matching /skill:gstack-* command',
    'Use the Skill tool': 'Use the matching /skill:gstack-* command',
    'Skill tool': '/skill:gstack-* command',
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'use the write tool',
    'use the Read tool': 'use the read tool',
    'use the Edit tool': 'use the edit tool',
    'use the Agent tool': 'use a Pi SDK session or configured subagent extension',
    'use the Grep tool': 'search with rg via bash',
    'use the Glob tool': 'find files via bash',
    'use the Read tool': 'use the read tool',
    'use the Write tool': 'use the write tool',
    'use the Edit tool': 'use the edit tool',
    'the Bash tool': 'the bash tool',
    'the Write tool': 'the write tool',
    'the Read tool': 'the read tool',
    'the Edit tool': 'the edit tool',
    'the Agent tool': 'a Pi SDK session or configured subagent extension',
    'Agent tool': 'Pi SDK session or configured subagent extension',
    'Grep tool': 'rg via bash',
    'Glob tool': 'find files via bash',
    'Read tool': 'read tool',
    'Write tool': 'write tool',
    'Edit tool': 'edit tool',
    'Bash tool': 'bash tool',
    'Claude subagent': 'configured Pi subagent',
    'AskUserQuestion': 'ask_user_question',
    'ExitPlanMode': 'stop and wait for user approval',
    'route to `/automate`': 'route to browser automation capability when available',
    'use /automate when shipped': 'use browser automation capability when shipped',
    "/automate's job": "the future automation skill's job",
    '/automate': 'browser automation capability when available',
    'WebSearch': 'web search capability',
  },

  suppressedResolvers: [
    'DESIGN_OUTSIDE_VOICES',
    'ADVERSARIAL_STEP',
    'CODEX_SECOND_OPINION',
    'CODEX_PLAN_REVIEW',
    'REVIEW_ARMY',
    'GBRAIN_CONTEXT_LOAD',
    'GBRAIN_SAVE_RESULTS',
  ],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'design/dist', 'make-pdf/dist', 'gstack-upgrade', 'qa/templates', 'qa/references', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
      'plan-devex-review': ['dx-hall-of-fame.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
  boundaryInstruction: 'Pi integrations should load generated Pi skills from ~/.pi/agent/skills or .pi/skills. Do not read Claude-only skill directories as runtime instructions unless explicitly debugging gstack generation.',
};

export default pi;
