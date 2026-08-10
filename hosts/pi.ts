import type { HostConfig } from '../scripts/host-config';

/** Pi package installed by setup to provide the `subagent` tool and builtin agents. */
export const PI_SUBAGENTS_PACKAGE = 'npm:pi-subagents';

/** Role mapping used by generated Pi delegation instructions. */
export const PI_SUBAGENT_ROLES = {
  review: 'reviewer',
  implementation: 'worker',
  reconnaissance: 'scout',
  secondOpinion: 'oracle',
  general: 'delegate',
} as const;

function piSingleWorkflow(agent: string, key = 'main'): string {
  return `Call the \`subagent\` tool with this input: {"workflowScript":"return runs.run('${key}', { agent: '${agent}', context: 'fresh', task: '<task>' })","async":false}.`;
}

function piParallelWorkflow(agent: string): string {
  return `Call the \`subagent\` tool with this input: {"workflowScript":"const [first, second] = await runs.all([{ key: 'first', agent: '${agent}', task: '<first task>' }, { key: 'second', agent: '${agent}', task: '<second task>' }]); return [first.output, second.output]","async":false}. Add one runs.all item for each selected task and return the collected outputs.`;
}

const pi: HostConfig = {
  name: 'pi',
  displayName: 'Pi',
  cliCommand: 'pi',
  cliAliases: [],

  globalRoot: '.pi/agent/skills/gstack',
  localSkillRoot: '.pi/skills/gstack',
  hostSubdir: '.pi',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.pi/agent/skills/gstack' },
    { from: '~/.claude/skills', to: '~/.pi/agent/skills' },
    { from: '$HOME/.claude/skills/gstack', to: '$HOME/.pi/agent/skills/gstack' },
    { from: '$HOME/.claude/skills', to: '$HOME/.pi/agent/skills' },
    { from: '.claude/skills/gstack', to: '.pi/skills/gstack' },
    { from: '.claude/skills', to: '.pi/skills' },
    // Pi uses AGENTS.md for project instructions.
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
    // Identity rewrites keep generated instructions host-neutral.
    { from: 'Claude Code', to: 'Pi' },
    { from: 'claude code', to: 'Pi' },
    { from: 'this Pi window', to: 'this Pi session' },
  ],

  toolRewrites: {
    'AskUserQuestion': 'ask the user in chat',
    'WebSearch': 'web search (if available)',
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'use the write tool',
    'use the Read tool': 'use the read tool',
    'use the Edit tool': 'use the edit tool',
    'use the Grep tool': 'use the grep tool',
    'use the Glob tool': 'use the find tool',
    'the Bash tool': 'the bash tool',
    'the Read tool': 'the read tool',
    'the Write tool': 'the write tool',
    'the Edit tool': 'the edit tool',
    'the Grep tool': 'the grep tool',
    'the Glob tool': 'the find tool',

    // pi-subagents exposes a workflowScript API rather than Claude's Agent
    // tool. Handle the complete high-value instructions before the generic
    // replacements below so the generated prose retains its intent.
    '**Launch N Agent subagents in a single message** (parallel execution). Use the Agent\ntool with `subagent_type: "general-purpose"` for each variant. Each agent is independent\nand handles its own generation, quality check, verification, and retry.': `**Launch N child agents in one workflowScript** (parallel execution). ${piParallelWorkflow(PI_SUBAGENT_ROLES.general)} Each child is independent and handles its own generation, quality check, verification, and retry.`,
    '**Dispatch this step as a subagent** using the Agent tool with `subagent_type: "general-purpose"`.': `**Dispatch this step with the subagent tool.** ${piSingleWorkflow(PI_SUBAGENT_ROLES.review)}`,
    '**Dispatch the fetch + classification as a subagent** using the Agent tool with `subagent_type: "general-purpose"`.': `**Dispatch the fetch + classification with the subagent tool.** ${piSingleWorkflow(PI_SUBAGENT_ROLES.reconnaissance)}`,
    '**Dispatch /document-release as a subagent** using the Agent tool with `subagent_type: "general-purpose"`.': `**Dispatch /document-release with the subagent tool.** ${piSingleWorkflow(PI_SUBAGENT_ROLES.implementation)}`,
    'For each selected specialist, launch an independent subagent via the Agent tool.\n**Launch ALL selected specialists in a single message** (multiple Agent tool calls)\nso they run in parallel. Each subagent has fresh context — no prior review bias.': `For each selected specialist, add a fresh reviewer child to one workflowScript. ${piParallelWorkflow(PI_SUBAGENT_ROLES.review)} Each child has fresh context — no prior review bias.`,
    'If activated, dispatch one more subagent via the Agent tool (foreground, not background).': `If activated, run one more reviewer child in a foreground workflow. ${piSingleWorkflow(PI_SUBAGENT_ROLES.review, 'red-team')}`,
    'For each candidate finding, launch an independent verification sub-task using the Agent tool. The verifier has fresh context and cannot see the initial scan\'s reasoning — only the finding itself and the FP filtering rules.': `For each candidate finding, add an independent reviewer child to a workflowScript. ${piParallelWorkflow(PI_SUBAGENT_ROLES.review)} Each verifier has fresh context and cannot see the initial scan's reasoning — only the finding itself and the FP filtering rules.`,
    'Launch all verifiers in parallel.': `Use a workflowScript with runs.all([...]) to launch all verifiers in parallel. ${piParallelWorkflow(PI_SUBAGENT_ROLES.review)}`,
    'Use the Agent tool to dispatch an independent reviewer. The reviewer has fresh context': `Use the subagent tool with a workflowScript. ${piSingleWorkflow(PI_SUBAGENT_ROLES.review)} The reviewer child has fresh context`,
    '**If CODEX_NOT_AVAILABLE (or Codex errored):**\n\nDispatch via the Agent tool. The subagent has fresh context — genuine independence.': `**If CODEX_NOT_AVAILABLE (or Codex errored):**\n\nUse the \`subagent\` tool with a workflowScript. ${piSingleWorkflow(PI_SUBAGENT_ROLES.secondOpinion)} The oracle child has fresh context — genuine independence.`,
    'Dispatch via the Agent tool. The subagent has fresh context': `Use the \`subagent\` tool with a workflowScript. ${piSingleWorkflow(PI_SUBAGENT_ROLES.review)} The reviewer child has fresh context`,
    'Dispatch via the Agent tool with the same prompt.': `Use the \`subagent\` tool with a workflowScript. ${piSingleWorkflow(PI_SUBAGENT_ROLES.review)} Pass it the same prompt and bound it at a 5-minute timeout.`,
    'Dispatch via the Agent tool.': `Use the \`subagent\` tool with a workflowScript. ${piSingleWorkflow(PI_SUBAGENT_ROLES.review)} `,

    // The autoplan and design templates describe the Agent tool in several
    // shorter forms. Keep those instructions, but point them at Pi's API.
    'via Agent tool': `via the \`subagent\` tool. ${piSingleWorkflow(PI_SUBAGENT_ROLES.review)}`,
    'foreground Agent tool': 'foreground `subagent` workflow (`async: false`)',
    'Agent tool,': '`subagent` tool with a `workflowScript`,',
    'Agent tool)': '`subagent` tool with a `workflowScript`)',
    'Claude subagent': 'Pi reviewer subagent',
    'Claude adversarial subagent': 'Pi adversarial reviewer subagent',
    'Claude design subagent': 'Pi design reviewer subagent',
    'Claude CEO subagent': 'Pi CEO reviewer subagent',
    'Claude eng subagent': 'Pi eng reviewer subagent',
    'Claude DX subagent': 'Pi DX reviewer subagent',
    'Claude-only': 'Pi-only',
    'Claude ': 'Pi ',
    'CLAUDE SUBAGENT': 'PI REVIEWER SUBAGENT',
    'Subagent prompt': 'Child-agent prompt',
    'subagent prompt': 'child-agent prompt',
    'subagent_type: "general-purpose"': 'agent: "delegate"',
    'do NOT use run_in_background': 'set `async: false` for this foreground run',
    'run_in_background': '`async: true`',
    'Claude Code\'s Agent tool': 'Pi\'s `subagent` tool',
    'agents do NOT inherit': 'child agents do NOT inherit',
    'Agent subagents': 'subagent children',
    'Agent tool': '`subagent` tool',
  },

  // Unlike Pi's bare CLI, pi-subagents provides the child sessions needed by
  // these workflows. Keep the delegation and outside-voice resolvers enabled;
  // setup installs the package before Pi skills are generated.
  suppressedResolvers: [],

  runtimeRoot: {
    globalSymlinks: [
      'bin', 'browse/dist', 'browse/bin', 'design/dist', 'make-pdf/dist',
      'extension', 'lib/diagram-render', 'gstack-upgrade', 'ETHOS.md',
    ],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
};

export default pi;
