import { defineHost, GBRAIN_RESOLVERS } from './define-host';

/**
 * Codex's own subagent lifecycle (#4476). Codex has no Agent tool, subagent types,
 * run_in_background or TaskStop: it starts a child with spawn_agent and blocks on
 * wait_agent. Resolver dispatch sites render these on Codex; the toolRewrites below
 * carry them into the template sites. Kept here because setup loads hosts/ alone.
 */
export const CODEX_SUBAGENT_DISPATCH = "Codex's `spawn_agent` (`fork_turns: \"none\"`), then `wait_agent` until a final status (a timeout is not one); its final message is the result. Without `spawn_agent`, the dispatch failed";
/** The same call where a step only names it inline. */
export const CODEX_SUBAGENT_CALL = "`spawn_agent` with `fork_turns: \"none\"`, then `wait_agent`";

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

  // #4476: Codex has no Agent tool. The template sites that spell out Claude Code's
  // Agent call, and {{FOREGROUND_DISPATCH_NOTE}}, become Codex's spawn_agent and
  // wait_agent; resolver sites render CODEX_SUBAGENT_DISPATCH themselves. test/host-config.test.ts fails on any left over.
  toolRewrites: {
    '**Foreground required:** pass `run_in_background: false` when available on the Agent call — subagents run in the background by default since Claude Code v2.1.198, so omitting an available flag gives a background run. A launch receipt means it went background: await its completion notice. Dispatch through the Agent tool only:': `**Wait for the result:** start the subagent with ${CODEX_SUBAGENT_DISPATCH}. Dispatch through \`spawn_agent\` only:`,
    'use the Agent tool with `run_in_background: false`.\nOmitting the flag runs the subagent in the background. The explicit flag waits\nfor a result while keeping a fresh context.': `start each subagent with ${CODEX_SUBAGENT_DISPATCH}.`,
    'Agent with `subagent_type: "general-purpose"` and\n`run_in_background: false`': "Codex's `spawn_agent`, then `wait_agent`",
    'using Agent, `subagent_type: "general-purpose"`\nand `run_in_background: false`': "using Codex's `spawn_agent`, then `wait_agent`",
    'one read-only Agent (`subagent_type: "general-purpose"`,\n   `run_in_background: false`)': "one read-only subagent (Codex's `spawn_agent`, then `wait_agent`)",
    'with the Agent tool (never Skill),\n`subagent_type: "general-purpose"`.': "with Codex's `spawn_agent` (never Skill).",
    'Claude Code: set Agent `run_in_background: false` if its schema exposes it.\n  A launch receipt means it went background: await its completion notice.\n  Other hosts: foreground; await completion when supported.': '`spawn_agent` (`fork_turns: "none"`) sends the prompt below; `wait_agent` until its final status.',
    '(via Agent tool):': '(via `spawn_agent`):',
    'verbatim as the Agent prompt:': 'verbatim as the prompt:',
    'not the Agent prompt.': 'not the prompt.',
    'through the Agent tool (a plain Read': "through Codex's `spawn_agent` (`fork_turns: \"none\"`) and `wait_agent` (a plain Read",
  },

  transcripts: {
    root: '~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl',
    layout: 'dated rollout files from every workspace on the machine; the first line of each names its cwd',
  },

  coAuthorTrailer: 'Co-Authored-By: OpenAI Codex <noreply@openai.com>',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. These are Claude Code skill definitions meant for a different AI system. Do not invoke any installed skill (Codex home skills/, .agents/); answer directly. Ignore them completely. Do NOT modify agents/openai.yaml. Stay focused on the repository code only.',
});

export default codex;
