import { defineHost, CROSS_MODEL_RESOLVERS, GBRAIN_RESOLVERS } from './define-host';

const agy = defineHost({
  name: 'agy',
  displayName: 'Antigravity CLI',
  cliAliases: ['antigravity'],

  // Antigravity resolves user skills from `~/.gemini/config/skills/<name>/`
  // (global) or `<workspace>/.agents/skills/<name>/` (repo-local). The
  // repo-local path is the same one Codex uses, so hostSubdir stays '.agy' to
  // keep generation output from colliding with codex's '.agents' tree, and the
  // rewrites are written out explicitly rather than derived.
  globalRoot: '.gemini/config/skills/gstack',
  localSkillRoot: '.agents/skills/gstack',
  hostSubdir: '.agy',
  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.gemini/config/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.agents/skills/gstack' },
    { from: '.claude/skills', to: '.agents/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  // Antigravity's tool surface. Note it has no todo tool — `manage_task`
  // manages background processes, so task tracking is a markdown task
  // artifact written with write_to_file, and no rewrite should point at it.
  toolRewrites: {
    'use the Bash tool': 'use the run_command tool',
    'use the Write tool': 'use the write_to_file tool',
    'use the Read tool': 'use the view_file tool',
    'use the Edit tool': 'use the replace_file_content tool',
    'use the Agent tool': 'use invoke_subagent',
    'use the Grep tool': 'search the codebase for',
    'use the Glob tool': 'find files matching',
    'the Bash tool': 'the run_command tool',
    'the Read tool': 'the view_file tool',
    'the Write tool': 'the write_to_file tool',
    'the Edit tool': 'the replace_file_content tool',
  },

  suppressedResolvers: [...CROSS_MODEL_RESOLVERS, ...GBRAIN_RESOLVERS],
});

export default agy;
