import type { HostConfig } from '../scripts/host-config';

const windsurf: HostConfig = {
  name: 'windsurf',
  displayName: 'Windsurf',
  cliCommand: 'windsurf',
  cliAliases: [],

  globalRoot: '.windsurf/skills/gstack',
  localSkillRoot: '.windsurf/skills/gstack',
  hostSubdir: '.windsurf',
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
    { from: '~/.claude/skills/gstack', to: '~/.windsurf/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.windsurf/skills/gstack' },
    { from: '.claude/skills', to: '.windsurf/skills' },
  ],

  toolRewrites: {
    // Agent/subagent (Cascade does not support spawning subagents)
    'use the Agent tool': 'perform the following steps inline (Cascade does not support subagents — adopt the described persona and do the work directly)',
    'Dispatch via the Agent tool': 'Perform inline (adopt the described persona and do the work directly)',
    'dispatch a subagent': 'perform the following steps inline',
    'dispatch one more subagent': 'perform one more inline review',
    'launch an independent subagent': 'perform an independent inline review',
    'Agent tool': 'inline execution',
    'subagent': 'inline task',

    // User interaction (Cascade has no AskUserQuestion tool — just ask directly)
    'Use AskUserQuestion': 'Ask the user directly',
    'use AskUserQuestion': 'ask the user directly',
    'via AskUserQuestion': 'by asking the user',
    'AskUserQuestion': 'ask the user',

    // Chrome MCP (not available in Windsurf)
    'mcp__claude-in-chrome__': '(NOT AVAILABLE in Windsurf) mcp__claude-in-chrome__',

    // Codex → Gemini rewrites (Windsurf uses Gemini CLI as its second opinion)
    'codex exec': 'gemini -p',
    'codex review': 'gemini -p',
    '`/codex review`': '`gemini -p` (second opinion)',
    '`/codex`': '`gemini -p` (second opinion)',
    '/codex review': 'gemini -p (second opinion)',
    'Codex Review': 'Gemini Review',
    'Codex review': 'Gemini review',
    'codex-review': 'gemini-review',
    'codex-plan-review': 'gemini-plan-review',
    'CODEX SAYS': 'GEMINI SAYS',
    'Codex SAYS': 'Gemini SAYS',
    'Codex Says': 'Gemini Says',
    'Codex CLI': 'Gemini CLI',
    'Codex authentication': 'Gemini authentication',
    'Codex timed out': 'Gemini timed out',
    'Codex returned': 'Gemini returned',
    'Codex found': 'Gemini found',
    'Codex challenged': 'Gemini challenged',
    'Codex ran': 'Gemini ran',
    'if Codex ran': 'if Gemini ran',
    'Codex was unavailable': 'Gemini was unavailable',
    'both Claude and Codex': 'both Cascade and Gemini',
    'Claude and Codex': 'Cascade and Gemini',
    'Codex and Claude': 'Gemini and Cascade',
    'Codex is available': 'Gemini is available',
    'Codex is NOT available': 'Gemini is NOT available',
    'codex/claude': 'gemini/cascade',
    'Install Codex': 'Install Gemini CLI',
    'npm install -g @openai/codex': 'npm install -g @anthropic/gemini-cli',
    'codex login': 'gemini auth login',
    'Codex adversarial': 'Gemini adversarial',
    'Codex structured': 'Gemini structured',
    'Codex design': 'Gemini design',
    'Codex CEO': 'Gemini CEO',
    'Codex cold': 'Gemini cold',
    'CODEX_AVAILABLE': 'GEMINI_AVAILABLE',
    'CODEX_NOT_AVAILABLE': 'GEMINI_NOT_AVAILABLE',
    'which codex': 'which gemini',
    'codex only': 'gemini only',
    'codex-only': 'gemini-only',
    'Codex only': 'Gemini only',

    // Preamble/docs references
    'if Codex is unavailable': 'if Gemini is unavailable',
    'Codex or Claude': 'Gemini or Cascade',
    '(Codex or Claude': '(Gemini or Cascade',
    '"$HOME/.codex/plans"': '"$HOME/.gemini/plans"',
    '- **CODEX:**': '- **GEMINI:**',
    'codex fixes': 'gemini fixes',
    'codex disagreements': 'gemini disagreements',
    'Codex disagreements': 'Gemini disagreements',
    'codex recommends': 'gemini recommends',

    // Autoplan-specific Codex→Gemini rewrites
    'Codex Prompts': 'Gemini Prompts',
    'sent to Codex': 'sent to Gemini',
    'Codex if available': 'Gemini if available',
    'then Codex': 'then Gemini',
    'Codex auth': 'Gemini auth',
    'codex disagrees': 'gemini disagrees',
    'Codex (Bash)': 'Gemini (Bash)',
    'Codex prompt': 'Gemini prompt',
    'Codex eng voice': 'Gemini eng voice',
    'Codex DX voice': 'Gemini DX voice',
    'Codex output': 'Gemini output',
    'Codex:': 'Gemini:',
    'Codex [summary]': 'Gemini [summary]',
    'Codex +': 'Gemini +',
    '(Codex +': '(Gemini +',
    'codex+': 'gemini+',
    'run codex': 'run gemini',
    'Codex from discovering': 'Gemini from discovering',
    'Codex if': 'Gemini if',

    // Table header pattern (spaces around Codex in consensus tables)
    'Claude  Codex  Consensus': 'Cascade  Gemini  Consensus',

    // Upstream repo rewrites (updates/upgrades point to fork)
    'github.com/garrytan/gstack': 'github.com/bjohnson135/gemini-gstack',
    'raw.githubusercontent.com/garrytan/gstack': 'raw.githubusercontent.com/bjohnson135/gemini-gstack',
    'garrytan/gstack': 'bjohnson135/gemini-gstack',
  },

  upstreamRepo: 'bjohnson135/gemini-gstack',
  disableRemoteTelemetry: true,
  disableUpdateCheck: true,

  secondOpinionCLI: {
    binary: 'gemini',
    displayName: 'Gemini',
    execTemplate: 'gemini -p "${PROMPT}"',
    boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.windsurf/, ~/.claude/, ~/.agents/, .windsurf/skills/, .claude/skills/, or agents/. These are AI agent skill definitions meant for a different system. Stay focused on the repository code only.\n\n',
  },

  // These two resolvers are deeply Codex-integrated (temp files, stderr capture,
  // multi-step prompt assembly). ADVERSARIAL_STEP and DESIGN_OUTSIDE_VOICES
  // already use secondOpinionCLI via the generalized pattern.
  suppressedResolvers: [
    'CODEX_SECOND_OPINION',   // /office-hours only — complex multi-phase flow
    'CODEX_PLAN_REVIEW',      // /plan-ceo-review, /plan-eng-review — complex flow
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

  learningsMode: 'basic',
};

export default windsurf;
