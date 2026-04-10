import type { HostConfig } from '../scripts/host-config';

const antigravity: HostConfig = {
  name: 'antigravity',
  displayName: 'Antigravity IDE',
  cliCommand: 'antigravity',
  cliAliases: ['gemini-antigravity'],

  globalRoot: '.gemini/antigravity/skills/gstack',
  localSkillRoot: '.antigravity/skills/gstack',
  hostSubdir: '.gemini/antigravity',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],  // Codex skill is a Claude wrapper around codex exec
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.gemini/antigravity/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.antigravity/skills/gstack' },
    { from: '.claude/skills/review', to: '.antigravity/skills/gstack/review' },
    { from: '.claude/skills', to: '.antigravity/skills' },
  ],

  toolRewrites: {
    'use the Bash tool': 'use the run_command tool',
    'use the Write tool': 'use the write_to_file tool',
    'use the Read tool': 'use the view_file tool',
    'use the Grep tool': 'use the grep_search tool',
    'use the Glob tool': 'use the list_dir tool',
    'use the Agent tool': 'use the browser_subagent tool',
  },

  suppressedResolvers: [
    'CODEX_PLAN_REVIEW',    // Cross-model invocation — not available
    'CODEX_SECOND_OPINION', // Cross-model invocation — not available
    'REVIEW_ARMY',          // Orchestration — Antigravity can't self-spawn
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

  paginationWarningLimit: 800,
  coAuthorTrailer: 'Co-Authored-By: Antigravity IDE <noreply@deepmind.google.com>',
  learningsMode: 'basic',
};

export default antigravity;
