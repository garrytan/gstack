import type { HostConfig } from '../scripts/host-config';

const openclaw: HostConfig = {
  name: 'openclaw',
  displayName: 'OpenClaw',
  cliCommand: 'openclaw',
  cliAliases: [],

  globalRoot: '.openclaw/skills/gstack',
  localSkillRoot: '.openclaw/skills/gstack',
  hostSubdir: '.openclaw',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
    extraFields: {
      version: '0.15.2.0',
    },
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
    includeSkills: [],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.openclaw/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.openclaw/skills/gstack' },
    { from: '.claude/skills', to: '.openclaw/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: {
    'use the Bash tool': 'use the exec tool',
    'use the Write tool': 'use the write tool',
    'use the Read tool': 'use the read tool',
    'use the Edit tool': 'use the edit tool',
    'use the Agent tool': 'use sessions_spawn',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
    'the Bash tool': 'the exec tool',
    'the Read tool': 'the read tool',
    'the Write tool': 'the write tool',
    'the Edit tool': 'the edit tool',
  },

  // Suppress Claude-specific preamble sections that don't apply to OpenClaw
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
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: OpenClaw Agent <agent@openclaw.ai>',
  learningsMode: 'basic',
};

export default openclaw;
