import type { HostConfig } from '../scripts/host-config';

const forgecode: HostConfig = {
  name: 'forgecode',
  displayName: 'Forge Code',
  cliCommand: 'forge',
  cliAliases: ['forge-code'],

  globalRoot: '.forgecode/skills/gstack',
  localSkillRoot: '.forgecode/skills/gstack',
  hostSubdir: '.forgecode',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.forgecode/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.forgecode/skills/gstack' },
    { from: '.claude/skills', to: '.forgecode/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: {
    'use the Bash tool': 'use the shell tool',
    'use the Write tool': 'use the patch tool',
    'use the Edit tool': 'use the patch tool',
    'use the Agent tool': 'use the sage tool',
    'use the Grep tool': 'use the fs_search tool',
    'use the Glob tool': 'use the fs_search tool',
    'the Bash tool': 'the shell tool',
    'the Write tool': 'the patch tool',
    'the Edit tool': 'the patch tool',
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
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'design/dist', 'gstack-upgrade', 'ETHOS.md', 'review/specialists', 'qa/templates', 'qa/references', 'plan-devex-review/dx-hall-of-fame.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: Forge Code <noreply@forgecode.dev>',
  learningsMode: 'basic',
};

export default forgecode;
