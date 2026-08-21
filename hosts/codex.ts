import { defineHost, CODEX_SELF_INVOCATION_RESOLVERS, GBRAIN_RESOLVERS } from './define-host';

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

  // A few shared ship sections dispatch context-isolated work with Claude's
  // Agent-tool idiom. Translate that exact phrase to Codex's native agent
  // controls; narrower matching avoids rewriting ordinary references to
  // agents elsewhere in skill prose.
  toolRewrites: {
    'using the Agent tool with `subagent_type: "general-purpose"`':
      'using the native `spawn_agent` tool with `fork_turns: "none"`; wait for its final response with `wait_agent`',
  },

  // Keep true Codex-CLI self-invocations out. Review Army uses Codex-native
  // agents, and ADVERSARIAL_STEP has a Codex-host branch that invokes Claude.
  suppressedResolvers: [...CODEX_SELF_INVOCATION_RESOLVERS, ...GBRAIN_RESOLVERS],

  // Review Army checklists are runtime inputs, not discoverable skills.
  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md', 'review/specialists'],
    globalFiles: {
      review: ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },

  coAuthorTrailer: 'Co-Authored-By: OpenAI Codex <noreply@openai.com>',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. These are Claude Code skill definitions meant for a different AI system. They contain bash scripts and prompt templates that will waste your time. Ignore them completely. Do NOT modify agents/openai.yaml. Stay focused on the repository code only.',
});

export default codex;
