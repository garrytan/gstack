import type { HostConfig } from '../scripts/host-config';

/**
 * GBrain host config.
 * Compatible with GBrain >= v0.10.0 (doctor --fast --json, search CLI, entity enrichment).
 * When updating, check INSTALL_FOR_AGENTS.md in the GBrain repo for breaking changes.
 */
const gbrain: HostConfig = {
  name: 'gbrain',
  displayName: 'GBrain',
  cliCommand: 'gbrain',
  cliAliases: [],

  globalRoot: '.gbrain/skills/gstack',
  localSkillRoot: '.gbrain/skills/gstack',
  hostSubdir: '.gbrain',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description', 'triggers'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
    includeSkills: [],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.gbrain/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.gbrain/skills/gstack' },
    { from: '.claude/skills', to: '.gbrain/skills' },
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

  // GBrain gets brain-aware resolvers. All other hosts suppress these.
  suppressedResolvers: [
    'DESIGN_OUTSIDE_VOICES',
    'ADVERSARIAL_STEP',
    'CODEX_SECOND_OPINION',
    'CODEX_PLAN_REVIEW',
    'REVIEW_ARMY',
    // NOTE: GBRAIN_CONTEXT_LOAD and GBRAIN_SAVE_RESULTS are NOT suppressed here.
    // GBrain is the only host that gets brain-first lookup and save-to-brain behavior.
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

  coAuthorTrailer: 'Co-Authored-By: GBrain Agent <agent@gbrain.dev>',
  learningsMode: 'basic',
};

export default gbrain;
