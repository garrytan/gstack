import type { HostConfig } from '../scripts/host-config';

const codex: HostConfig = {
  name: 'codex',
  displayName: 'OpenAI Codex CLI',
  cliCommand: 'codex',
  cliAliases: ['agents'],

  globalRoot: '.codex/skills/gstack',
  localSkillRoot: '.agents/skills/gstack',
  hostSubdir: '.agents',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'error',
  },

  generation: {
    generateMetadata: true,
    metadataFormat: 'openai.yaml',
    skipSkills: ['codex'],  // Codex skill is a Claude wrapper around codex exec
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '.agents/skills/gstack' },
    { from: '.claude/skills/review', to: '.agents/skills/gstack/review' },
    { from: '.claude/skills', to: '.agents/skills' },
  ],
  toolRewrites: {
    'subagent_type: "general-purpose"': 'agent_type: "default"',
    "Claude Code's Agent tool": 'Codex subagent tool',
    'Claude adversarial subagent': 'independent adversarial subagent',
    'Claude design subagent': 'independent design subagent',
    'Claude CEO subagent': 'independent CEO subagent',
    'Claude eng subagent': 'independent eng subagent',
    'Claude DX subagent': 'independent DX subagent',
    'Claude subagent': 'independent subagent',
    'using the Agent tool': 'using a Codex subagent',
    'via the Agent tool': 'via a Codex subagent',
    'Use the Agent tool': 'Spawn a Codex subagent',
    'use the Agent tool': 'spawn a Codex subagent',
    'Agent tool': 'Codex subagent tool',
    'using spawned agents only': 'using spawned Codex agents only',
    'foreground Agent tool': 'foreground Codex subagent',
    'If the Agent tool is unavailable': 'If Codex subagents are unavailable',
    'use the Bash tool': 'run the command in the shell',
    'Use the Bash tool': 'Run the command in the shell',
    'use the Read tool': 'read the file',
    'Use the Read tool': 'Read the file',
    'use the Write tool': 'create the file',
    'Use the Write tool': 'Create the file',
    'use the Edit tool': 'edit the file',
    'Use the Edit tool': 'Edit the file',
    'use the Grep tool': 'search with rg',
    'Use the Grep tool': 'Search with rg',
    'use the Glob tool': 'find files',
    'Use the Glob tool': 'Find files',
  },

  suppressedResolvers: [
    'DESIGN_OUTSIDE_VOICES',  // design.ts:485 — Codex can't invoke itself
    'ADVERSARIAL_STEP',       // review.ts:408 — Codex can't invoke itself
    'CODEX_SECOND_OPINION',   // review.ts:257 — Codex can't invoke itself
    'CODEX_PLAN_REVIEW',      // review.ts:541 — Codex can't invoke itself
    'REVIEW_ARMY',            // review-army.ts:180 — Codex shouldn't orchestrate
    'GBRAIN_CONTEXT_LOAD',
    'GBRAIN_SAVE_RESULTS',
  ],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },
  sidecar: {
    path: '.agents/skills/gstack',
    symlinks: ['bin', 'browse', 'review', 'qa', 'ETHOS.md'],
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: OpenAI Codex <noreply@openai.com>',
  defaultModel: 'gpt-5.4',
  hostOverlay: 'host-overlays/codex.md',
  learningsMode: 'basic',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. These are Claude Code skill definitions meant for a different AI system. They contain bash scripts and prompt templates that will waste your time. Ignore them completely. Do NOT modify agents/openai.yaml. Stay focused on the repository code only.',
};

export default codex;
