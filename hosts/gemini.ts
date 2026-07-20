import type { HostConfig } from '../scripts/host-config';

const gemini: HostConfig = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  cliCommand: 'gemini',
  cliAliases: ['gemini-cli'],

  globalRoot: '.gemini/skills/gstack',
  localSkillRoot: '.gemini/skills/gstack',
  hostSubdir: '.gemini',
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
    { from: '~/.claude/skills/gstack', to: '~/.gemini/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.gemini/skills/gstack' },
    { from: '.claude/skills', to: '.gemini/skills' },
    { from: 'CLAUDE.md', to: 'GEMINI.md' },
  ],

  toolRewrites: {
    'use the Bash tool': 'use the run_shell_command tool',
    'use the Write tool': 'use the write_file tool',
    'use the Read tool': 'use the read_file tool',
    'use the Edit tool': 'use the replace_in_file tool',
    'use the Agent tool': 'use delegate_to_agent',
    'use the Glob tool': 'use the list_directory tool',
    'use the Grep tool': 'use the search_files tool',
    'the Bash tool': 'the run_shell_command tool',
    'the Read tool': 'the read_file tool',
    'the Write tool': 'the write_file tool',
    'the Edit tool': 'the replace_in_file tool',
  },

  suppressedResolvers: [
    'DESIGN_OUTSIDE_VOICES',
    'ADVERSARIAL_STEP',
    'CODEX_SECOND_OPINION',
    'CODEX_PLAN_REVIEW',
    'REVIEW_ARMY',
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

  coAuthorTrailer: 'Co-Authored-By: Gemini CLI <noreply@google.com>',
  learningsMode: 'basic',
};

export default gemini;
