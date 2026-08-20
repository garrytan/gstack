import { defineHost, CROSS_MODEL_RESOLVERS, GBRAIN_RESOLVERS } from './define-host';

const codex = defineHost({
  name: 'codex',
  displayName: 'OpenAI Codex CLI',
  cliAliases: ['agents'],
  defaultModel: 'gpt',

  localSkillRoot: '.agents/skills/gstack',
  hostSubdir: '.agents',

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'error',
  },

  // generateMetadata emits agents/openai.yaml (the format is hardcoded in
  // gen-skill-docs.ts). Codex also gets a repo-local sidecar at
  // .agents/skills/gstack (symlinked runtime assets: bin, browse, review, qa,
  // ETHOS.md) — that behavior lives in setup's create_agents_sidecar, not here.
  generation: {
    generateMetadata: true,
    skipSkills: ['codex'],  // Codex skill is a Claude wrapper around codex exec
  },

  // Non-mechanical rewrites: the global path becomes $GSTACK_ROOT (resolved by
  // the preamble env vars), plus an extra review-path rewrite the derived trio
  // doesn't cover.
  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '.agents/skills/gstack' },
    { from: '.claude/skills/review', to: '.agents/skills/gstack/review' },
    { from: '.claude/skills', to: '.agents/skills' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  // The cross-model resolvers all shell out to Codex — Codex can't invoke itself.
  suppressedResolvers: [...CROSS_MODEL_RESOLVERS, ...GBRAIN_RESOLVERS],

  coAuthorTrailer: 'Co-Authored-By: OpenAI Codex <noreply@openai.com>',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. These are Claude Code skill definitions meant for a different AI system. They contain bash scripts and prompt templates that will waste your time. Ignore them completely. Do NOT modify agents/openai.yaml. Stay focused on the repository code only.',
});

export default codex;
