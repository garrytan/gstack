import type { HostConfig } from '../scripts/host-config';

const gemini: HostConfig = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  cliCommand: 'gemini',
  cliAliases: [],

  // Gemini extensions live in ~/.gemini/extensions/<name>/
  // When linked via `gemini extensions link`, the repo root IS the extension.
  // gen-skill-docs outputs to .gemini/skills/; setup creates a `skills` symlink
  // at the repo root pointing there so Gemini discovers them.
  globalRoot: '.gemini/extensions/gstack',
  localSkillRoot: '.gemini/extensions/gstack',
  hostSubdir: '.gemini',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],  // Codex skill is Claude-specific
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '.gemini/extensions/gstack' },
    { from: '.claude/skills/review', to: '.gemini/extensions/gstack/review' },
    { from: '.claude/skills', to: '.gemini/extensions' },
  ],

  toolRewrites: {
    'use the Bash tool': 'run this command',
    'use the Write tool': 'create this file',
    'use the Read tool': 'read the file',
    'use the Agent tool': 'dispatch a subagent',
    'use the Grep tool': 'search for',
    'use the Glob tool': 'find files matching',
    'use the Skill tool to invoke': 'invoke the skill',
    'invoke the Skill tool': 'invoke the skill',
  },

  suppressedResolvers: [
    'CODEX_SECOND_OPINION',
    'CODEX_PLAN_REVIEW',
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
