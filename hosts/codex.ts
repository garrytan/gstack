import { defineHost, GBRAIN_RESOLVERS } from './define-host';

const codex = defineHost({
  name: 'codex',
  displayName: 'OpenAI Codex CLI',
  tier: 'experimental',
  capabilities: { toolExecution: true, questions: 'prose', planMode: false, delegation: false, browser: true, safetyHooks: 'advisory' },
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
  // gen-skill-docs.ts; a template's `codex_default_prompt:` frontmatter key
  // sets its default_prompt, else "Use <name> for this task."). Codex also
  // gets a repo-local sidecar at
  // .agents/skills/gstack (symlinked runtime assets: bin, lib, browse, review,
  // qa, design/dist, make-pdf/dist, ETHOS.md) — that behavior lives in setup's
  // create_agents_sidecar, not here.
  generation: {
    generateMetadata: true,
    skipSkills: ['codex'],
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

  // Outside-review resolvers route to Claude Code; Review Army has its own restriction.
  suppressedResolvers: ['REVIEW_ARMY', ...GBRAIN_RESOLVERS],

  transcripts: {
    root: '~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl',
    layout: 'dated rollout files from every workspace on the machine; the first line of each names its cwd',
  },

  coAuthorTrailer: 'Co-Authored-By: OpenAI Codex <noreply@openai.com>',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, or .claude/skills/. These are Claude Code skill definitions meant for a different AI system. Do not invoke any installed skill (Codex home skills/, .agents/); answer directly. Ignore them completely. Do NOT modify agents/openai.yaml. Stay focused on the repository code only.',
});

export default codex;
