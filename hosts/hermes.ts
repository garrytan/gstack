import type { HostConfig } from '../scripts/host-config';

const hermes: HostConfig = {
  name: 'hermes',
  displayName: 'Hermes',
  cliCommand: 'hermes',  // installed executable is `hermes`; the repo/product is `hermes-agent` (nousresearch/hermes-agent)
  cliAliases: [],

  globalRoot: '.hermes/skills/gstack',
  localSkillRoot: '.hermes/skills/gstack',
  hostSubdir: '.hermes',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
    includeSkills: [],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.hermes/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.hermes/skills/gstack' },
    { from: '.claude/skills', to: '.hermes/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: {
    'use the Bash tool': 'use the terminal tool',
    'use the Write tool': 'use the patch tool',
    'use the Read tool': 'use the read_file tool',
    'use the Edit tool': 'use the patch tool',
    'use the Agent tool': 'use delegate_task',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
    'the Bash tool': 'the terminal tool',
    'the Read tool': 'the read_file tool',
    'the Write tool': 'the patch tool',
    'the Edit tool': 'the patch tool',
  },

  suppressedResolvers: [
    'DESIGN_OUTSIDE_VOICES',
    'ADVERSARIAL_STEP',
    'CODEX_SECOND_OPINION',
    'CODEX_PLAN_REVIEW',
    'REVIEW_ARMY',
    // GBRAIN_CONTEXT_LOAD and GBRAIN_SAVE_RESULTS are NOT suppressed: Hermes is brain-capable
    // (can carry GBrain as a mod), so with GBrain installed these activate automatically. With
    // GBrain absent, the rendered blocks still instruct `gbrain` commands, but each ends with a
    // fallback ("if GBrain is not available, proceed without / skip this step"), so a no-GBrain
    // agent recovers after a failed probe rather than getting stuck. (gbrain is the only other
    // non-suppressing host, and it always has GBrain installed.)
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

  coAuthorTrailer: 'Co-Authored-By: Hermes Agent <agent@nousresearch.com>',
  learningsMode: 'basic',
};

export default hermes;
