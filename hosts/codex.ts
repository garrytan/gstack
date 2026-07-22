import type { HostConfig } from '../scripts/host-config';

const CODEX_ENTRYPOINT_REQUIREMENTS: Record<string, string[]> = Object.fromEntries([
  'gstack', 'pair-agent', 'benchmark', 'design-html', 'plan-tune', 'design-shotgun',
  'plan-design-review', 'autoplan', 'design-consultation', 'learn', 'freeze', 'ios-qa',
  'careful', 'cso', 'canary', 'open-gstack-browser', 'diagram', 'investigate',
  'context-restore', 'claude', 'document-release', 'health', 'gstack-upgrade',
  'land-and-deploy', 'spec', 'qa', 'scrape', 'qa-only', 'skillify', 'sync-gbrain',
  'setup-browser-cookies', 'ios-fix', 'ios-clean', 'setup-gbrain', 'document-generate',
  'review', 'plan-ceo-review', 'office-hours', 'landing-report', 'retro',
  'ios-design-review', 'devex-review', 'benchmark-models', 'plan-devex-review',
  'ios-sync', 'browse', 'design-review', 'ship', 'plan-eng-review', 'guard',
  'make-pdf', 'unfreeze', 'context-save', 'setup-deploy',
].map(name => [name, []]));
for (const name of ['ship', 'review', 'land-and-deploy', 'spec', 'document-release', 'document-generate', 'landing-report']) {
  CODEX_ENTRYPOINT_REQUIREMENTS[name] = ['github-cli', 'network-required'];
}
for (const name of ['browse', 'qa', 'qa-only', 'canary', 'benchmark', 'scrape', 'setup-browser-cookies', 'open-gstack-browser', 'pair-agent']) {
  CODEX_ENTRYPOINT_REQUIREMENTS[name] = ['browser-runtime', 'network-required'];
}
for (const name of ['design-consultation', 'design-shotgun', 'design-review', 'design-html']) {
  CODEX_ENTRYPOINT_REQUIREMENTS[name] = ['openai-image-config', 'network-required'];
}

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
    "Claude Code's Agent tool": 'Codex native sub-agent delegation (`spawn_agent`)',
    'Claude adversarial subagent': 'independent adversarial subagent',
    'Claude CEO subagent': 'independent CEO subagent',
    'Claude DX subagent': 'independent DX subagent',
    'Claude design subagent': 'independent design subagent',
    'Claude eng subagent': 'independent engineering subagent',
    'Claude subagent': 'independent Codex subagent',
    'CLAUDE SUBAGENT': 'CODEX SUBAGENT',
    'Agent tool': 'Codex native sub-agent delegation (`spawn_agent`)',
    '`subagent_type: "general-purpose"`': 'a concrete bounded task',
    'subagent_type: "general-purpose"': 'native bounded-task dispatch',
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
    contract: {
      schemaVersion: 1,
      contractVersion: '1.0.0',
      assets: [
        { source: '.agents/skills/gstack/SKILL.md', destination: 'SKILL.md', kind: 'generated-file', targets: ['global', 'sidecar'] },
        { source: '.agents/skills/gstack/agents/openai.yaml', destination: 'agents/openai.yaml', kind: 'generated-file', targets: ['global', 'sidecar'] },
        { source: '.agents/skills/gstack/runtime-dependencies.json', destination: 'runtime-dependencies.json', kind: 'generated-file', targets: ['global', 'sidecar'] },
        { source: 'bin', destination: 'bin', kind: 'directory', targets: ['global', 'sidecar'] },
        { source: 'browse/dist', destination: 'browse/dist', kind: 'directory', targets: ['global', 'sidecar'], materializeAtInstall: true },
        { source: 'browse/bin', destination: 'browse/bin', kind: 'directory', targets: ['global', 'sidecar'] },
        { source: 'design/dist', destination: 'design/dist', kind: 'directory', targets: ['global', 'sidecar'], materializeAtInstall: true },
        { source: 'make-pdf/dist', destination: 'make-pdf/dist', kind: 'directory', targets: ['global', 'sidecar'], materializeAtInstall: true },
        { source: '.agents/skills/gstack-upgrade/SKILL.md', destination: 'gstack-upgrade/SKILL.md', kind: 'generated-file', targets: ['global', 'sidecar'] },
        { source: 'review/checklist.md', destination: 'review/checklist.md', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'review/design-checklist.md', destination: 'review/design-checklist.md', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'review/greptile-triage.md', destination: 'review/greptile-triage.md', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'review/TODOS-format.md', destination: 'review/TODOS-format.md', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'review/specialists', destination: 'review/specialists', kind: 'directory', targets: ['global', 'sidecar'] },
        { source: 'qa/templates', destination: 'qa/templates', kind: 'directory', targets: ['global', 'sidecar'] },
        { source: 'qa/references', destination: 'qa/references', kind: 'directory', targets: ['global', 'sidecar'] },
        { source: 'plan-devex-review/dx-hall-of-fame.md', destination: 'plan-devex-review/dx-hall-of-fame.md', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'lib', destination: 'lib', kind: 'directory', targets: ['global', 'sidecar'] },
        { source: 'scripts/jargon-list.json', destination: 'scripts/jargon-list.json', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'design-html/vendor/pretext.js', destination: 'design-html/vendor/pretext.js', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'VERSION', destination: 'VERSION', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'runtime/codex-runtime-contract.json', destination: 'runtime/codex-runtime-contract.json', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'codex/hooks/gstack-runtime-health.json', destination: 'codex/hooks/gstack-runtime-health.json', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'codex/hooks/ensure-gstack-model.sh', destination: 'codex/hooks/ensure-gstack-model.sh', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'scripts/codex-hook-config.ts', destination: 'scripts/codex-hook-config.ts', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'scripts/codex-hook-state.ts', destination: 'scripts/codex-hook-state.ts', kind: 'file', targets: ['global', 'sidecar'] },
        { source: 'ETHOS.md', destination: 'ETHOS.md', kind: 'file', targets: ['global', 'sidecar'] },
      ],
      capabilities: [
        ...['spec', 'browse', 'qa', 'design-review', 'investigate', 'office-hours', 'workflow-routing'].map(name => ({ id: `gstack.${name}`, version: '1.0.0', description: `Codex ${name} workflow capability` })),
        { id: 'agent.dispatch', version: '1.0.0', description: 'Native Codex subagent dispatch in generated workflows' },
        ...['asset-plan', 'dependency-closure', 'read-only-health', 'atomic-install', 'invocation-preflight'].map(name => ({ id: `codex.runtime.${name}`, version: '1.0.0', description: `Codex runtime ${name}` })),
      ],
      requirements: [
        { id: 'codex-cli', kind: 'executable-version', required: true, names: ['codex'], versionRange: '>=0.144.0', description: 'Codex CLI with hooks and repository skill support' },
        { id: 'bun-runtime', kind: 'executable-version', required: true, names: ['bun'], versionRange: '>=1.2.0', description: 'Runtime executor' },
        { id: 'git-runtime', kind: 'executable-version', required: true, names: ['git'], versionRange: '>=2.30.0', description: 'Source identity' },
        { id: 'codex-auth-config', kind: 'config-presence', required: true, names: ['auth.json', 'config.toml'], description: 'Codex auth/config present without recording values' },
        { id: 'filesystem-trust', kind: 'permission', required: true, names: ['read-runtime-root', 'execute-bin'], description: 'Runtime readable and executable' },
        { id: 'provider-tools', kind: 'tool-provider', required: false, names: ['mcp', 'connectors'], description: 'Optional providers' },
        { id: 'network-runtime', kind: 'network', required: false, description: 'Optional outbound network' },
        { id: 'network-required', kind: 'network', required: true, description: 'Outbound network' },
        { id: 'github-cli', kind: 'executable-version', required: true, names: ['gh'], versionRange: '>=2.40.0', description: 'GitHub operations' },
        { id: 'browser-runtime', kind: 'tool-provider', required: true, names: ['gstack-browse'], description: 'Bundled browser runtime' },
        { id: 'openai-image-config', kind: 'config-presence', required: true, names: ['OPENAI_API_KEY'], description: 'OpenAI image configuration' },
        { id: 'supported-os', kind: 'platform', required: true, platforms: ['darwin', 'linux'], description: 'Supported OS' },
      ],
      entrypointRequirements: CODEX_ENTRYPOINT_REQUIREMENTS,
    },
  },
  sidecar: {
    path: '.agents/skills/gstack',
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: OpenAI Codex <noreply@openai.com>',
  learningsMode: 'basic',
  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. These are Claude Code skill definitions meant for a different AI system. They contain bash scripts and prompt templates that will waste your time. Ignore them completely. Do NOT modify agents/openai.yaml. Stay focused on the repository code only.',
};

export default codex;
