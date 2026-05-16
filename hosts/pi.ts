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
    { from: '.claude/skills/gstack', to: '.pi/skills/gstack' },
    { from: '.claude/skills/review', to: '.pi/skills/gstack/review' },
    { from: '.claude/skills', to: '.pi/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  toolRewrites: {
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'use the write tool',
    'use the Read tool': 'use the read tool',
    'use the Edit tool': 'use the edit tool',
    'use the Agent tool': 'use a Pi SDK session or configured subagent extension',
    'use the Grep tool': 'search with rg via bash',
    'use the Glob tool': 'find files via bash',
    'the Bash tool': 'the bash tool',
    'the Write tool': 'the write tool',
    'the Read tool': 'the read tool',
    'the Edit tool': 'the edit tool',
    'the Agent tool': 'a Pi SDK session or configured subagent extension',
    'AskUserQuestion': 'ask_user_question',
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
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'design/dist', 'make-pdf/dist', 'gstack-upgrade', 'ETHOS.md'],
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
