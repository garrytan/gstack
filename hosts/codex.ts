import { defineHost, CROSS_MODEL_RESOLVERS, GBRAIN_RESOLVERS } from './define-host';

const codex = defineHost({
  name: 'codex',
  displayName: 'OpenAI Codex CLI',
  cliAliases: ['agents'],

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
    // Parent-side /ship attestation also needs to work when each Codex shell
    // starts without the preamble's GSTACK_ROOT assignment. Resolve the
    // runtime afresh in the command itself for both supported install modes.
    {
      from: 'SHIP_ATTEST=~/.claude/skills/gstack/bin/gstack-ship-attest',
      to: 'REPO_ROOT="$(git rev-parse --show-toplevel)"\nif [ -x "$REPO_ROOT/.agents/skills/gstack/bin/gstack-ship-attest" ]; then\n  SHIP_ATTEST="$REPO_ROOT/.agents/skills/gstack/bin/gstack-ship-attest"\nelse\n  SHIP_ATTEST="${HOME}/.codex/skills/gstack/bin/gstack-ship-attest"\nfi',
    },
    // Claude installs document-release below the gstack runtime, while Codex
    // installs generated skills as flat gstack-* siblings. Prefer the active
    // repo-local install, then fall back to the global Codex skills directory.
    {
      from: '`${HOME}/.claude/skills/gstack/document-release/SKILL.md`',
      to: '`.agents/skills/gstack-document-release/SKILL.md` if that file exists in the repository; otherwise `${HOME}/.codex/skills/gstack-document-release/SKILL.md`',
    },
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
