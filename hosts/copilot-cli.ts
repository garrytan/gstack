import type { HostConfig } from '../scripts/host-config';

const copilotCli: HostConfig = {
  name: 'copilot-cli',
  displayName: 'GitHub Copilot CLI',
  cliCommand: 'copilot',
  cliAliases: ['gh'],

  globalRoot: '.copilot/skills/gstack',
  localSkillRoot: '.github/skills/gstack',
  hostSubdir: '.copilot',
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
    { from: '~/.claude/skills/gstack', to: '~/.copilot/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.github/skills/gstack' },
    { from: '.claude/skills', to: '.github/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  toolRewrites: {
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'use the create tool',
    'use the Read tool': 'use the view tool',
    'use the Edit tool': 'use the edit tool',
    'use the Agent tool': 'use the task tool',
    'use the Grep tool': 'use the grep tool',
    'use the Glob tool': 'use the glob tool',
    'the Bash tool': 'the bash tool',
    'the Read tool': 'the view tool',
    'the Write tool': 'the create tool',
    'the Edit tool': 'the edit tool',
    'the Agent tool': 'the task tool',
    'via the Agent tool': 'via the task tool',
    'via Agent tool': 'via the task tool',
    'AskUserQuestion': 'ask_user',
    'WebSearch': 'web_fetch',
  },

  suppressedResolvers: [
    'CODEX_SECOND_OPINION',
    'CODEX_PLAN_REVIEW',
    'GBRAIN_CONTEXT_LOAD',
    'GBRAIN_SAVE_RESULTS',
  ],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: Copilot <223556219+Copilot@users.noreply.github.com>',
  learningsMode: 'basic',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, .claude/skills/, or ~/.agents/. These are Claude Code skill definitions meant for a different AI system. They contain prompt templates that will waste your context window. Ignore them completely. When running gstack skills, read from ~/.copilot/skills/ or .github/skills/ only.',
};

export default copilotCli;
