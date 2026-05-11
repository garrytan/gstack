import type { HostConfig } from '../scripts/host-config';

/**
 * GitHub Copilot CLI host.
 *
 * Copilot CLI discovers custom agents as flat `.agent.md` files in
 * `~/.copilot/agents/`. Each file has YAML frontmatter (name, description,
 * tools, target, etc.) followed by markdown instructions. Invoke with
 * `copilot --agent <name>`.
 *
 * Schema reference:
 *   https://docs.github.com/en/copilot/reference/custom-agents-configuration
 *
 * gstack skills are emitted as `gstack-<skill>.agent.md` (flat with prefix —
 * Copilot CLI does not recurse into subdirectories under ~/.copilot/agents/).
 */
const copilot: HostConfig = {
  name: 'copilot',
  displayName: 'GitHub Copilot CLI',
  cliCommand: 'copilot',

  globalRoot: '.copilot/agents',
  localSkillRoot: '.copilot/agents',
  hostSubdir: '.copilot',
  usesEnvVars: true,

  outputLayout: 'flat-agent-md',

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: 1024,
    descriptionLimitBehavior: 'truncate',
    extraFields: {
      // `target` is intentionally omitted — defaults to "both" (Copilot CLI + VS Code
      // Copilot extension), maximising reach. Set to "github-copilot" or "vscode" to
      // narrow if a deployment ever needs that.
      // gstack skills need broad tool access. Emit as YAML array via stringified literal —
      // transformFrontmatter does string-interpolation, so the value is rendered verbatim.
      // (If transformFrontmatter ever gains real array support, switch to a JS array.)
      tools: '["*"]',
    },
  },

  generation: {
    generateMetadata: false,
    // Skipped because they don't fit Copilot CLI's stateless single-invocation
    // agent model. They either toggle session state, configure other skills,
    // or wrap a binary that should not recurse:
    //   'codex'       — wraps the `codex` CLI binary (every external host skips this)
    //   'copilot'     — would recurse: this skill wraps the `copilot` CLI itself
    //   'freeze'      — toggles a session-scoped edit boundary; agents are stateless
    //   'unfreeze'    — pairs with /freeze; same reason
    //   'careful'     — installs session-scoped destructive-command guardrails
    //   'guard'       — combines /careful + /freeze; same reason
    //   'plan-tune'   — interactive UI for tuning AskUserQuestion sensitivity
    //                   per-skill; only meaningful inside a persistent skill system
    // Follow-up worth filing: the rules from freeze/careful/guard could be
    // injected into a project AGENTS.md template so they're ambient across
    // every Copilot CLI invocation, recovering the protection we drop here.
    skipSkills: ['codex', 'copilot', 'freeze', 'unfreeze', 'careful', 'guard', 'plan-tune'],
  },

  pathRewrites: [
    // Copilot CLI installs are global-only — agents live in ~/.copilot/agents/
    // and runtime support files (bin/, browse/) live in ~/.copilot/gstack/ via
    // $GSTACK_ROOT. Both the `~/.claude/skills/gstack` references (absolute, in
    // bash blocks) AND the `.claude/skills` references (project-local hints in
    // prose) need to point at the same runtime root, since Copilot CLI doesn't
    // currently have a per-workspace agents directory.
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills', to: '$GSTACK_ROOT' },
  ],

  suppressedResolvers: [
    'DESIGN_OUTSIDE_VOICES',
    'ADVERSARIAL_STEP',
    'CODEX_SECOND_OPINION',
    'CODEX_PLAN_REVIEW',
    'REVIEW_ARMY',
    'GBRAIN_CONTEXT_LOAD',
    'GBRAIN_SAVE_RESULTS',
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

  coAuthorTrailer: 'Co-Authored-By: GitHub Copilot <noreply@github.com>',
  learningsMode: 'basic',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. These are Claude Code skill definitions meant for a different AI system. Ignore them. Stay focused on the repository code only.',
};

export default copilot;
