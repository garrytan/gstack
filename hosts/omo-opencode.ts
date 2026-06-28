import type { HostConfig } from '../scripts/host-config';

/**
 * omo-opencode = OpenCode + the oh-my-openagent (Sisyphus) stack.
 *
 * Tags each gstack SKILL.md with an `omo-route` field naming the OMO agent or
 * category that should own it. OMO routing then happens in user JSONC
 * (~/.config/opencode/oh-my-openagent.jsonc); these tags are advisory metadata
 * + the documented source of truth. Add to OMO_ROUTING and re-run gen:skill-docs.
 *
 * gstack matches `if` keys as `^k:\s*v` (no end anchor), so `name: plan-`
 * fans out across `plan-eng-review`, `plan-ceo-review`, etc. Use full names
 * for singletons. Docs: docs/host-omo-opencode.md.
 */
const OMO_ROUTING: Array<{ name: string; route: string }> = [
  // Planning / architecture review → prometheus agent (planner)
  { name: 'office-hours',     route: 'prometheus' },
  { name: 'spec',             route: 'prometheus' },
  { name: 'plan-',            route: 'prometheus' }, // plan-ceo|eng|design|devex|tune-review
  { name: 'autoplan',         route: 'prometheus' },
  { name: 'skillify',         route: 'prometheus' },

  // Deep review / debugging consultation → oracle agent
  { name: 'review',           route: 'oracle' },
  { name: 'qa',               route: 'oracle' }, // matches qa AND qa-only
  { name: 'cso',              route: 'oracle' },
  { name: 'investigate',      route: 'oracle' },
  { name: 'devex-review',     route: 'oracle' },
  { name: 'careful',          route: 'oracle' },

  // Shipping / deployment / iOS rollout → atlas agent (orchestrator)
  { name: 'ship',             route: 'atlas' },
  { name: 'land-and-deploy',  route: 'atlas' },
  { name: 'canary',           route: 'atlas' },
  { name: 'ios-',             route: 'atlas' }, // ios-clean|design-review|fix|qa|sync

  // Design surface → unspecified-high category (Opus/GPT-5 high)
  { name: 'design',           route: 'unspecified-high' },
  { name: 'design-',          route: 'unspecified-high' }, // design-consultation|html|review|shotgun

  // Document / diagram / landing-report → writing category
  { name: 'document-generate', route: 'writing' },
  { name: 'document-release',  route: 'writing' },
  { name: 'landing-report',    route: 'writing' },
  { name: 'diagram',           route: 'writing' },
  { name: 'make-pdf',          route: 'writing' },
  { name: 'retro',             route: 'writing' },

  // Browser / scrape / health → quick category (cheap cycle)
  { name: 'browse',            route: 'quick' },
  { name: 'scrape',            route: 'quick' },
  { name: 'health',            route: 'quick' },
  { name: 'open-gstack-browser', route: 'quick' },

  // Setup / utility / state mgmt → sisyphus-junior agent (focused executor)
  { name: 'freeze',            route: 'sisyphus-junior' },
  { name: 'unfreeze',          route: 'sisyphus-junior' },
  { name: 'guard',             route: 'sisyphus-junior' },
  { name: 'learn',             route: 'sisyphus-junior' },
  { name: 'connect-chrome',    route: 'sisyphus-junior' },
  { name: 'setup-',            route: 'sisyphus-junior' }, // setup-deploy|gbrain|browser-cookies
  { name: 'sync-gbrain',       route: 'sisyphus-junior' },
  { name: 'pair-agent',        route: 'sisyphus-junior' },
  { name: 'supabase',          route: 'sisyphus-junior' },
  { name: 'context-save',      route: 'sisyphus-junior' },
  { name: 'context-restore',   route: 'sisyphus-junior' },
  { name: 'gstack-upgrade',    route: 'sisyphus-junior' },

  // gstack router itself → sisyphus (top-level orchestrator)
  { name: 'gstack',            route: 'sisyphus' },
];

const omoOpencode: HostConfig = {
  name: 'omo-opencode',
  displayName: 'OpenCode + oh-my-openagent (Sisyphus stack)',
  cliCommand: 'opencode',
  cliAliases: ['omo', 'omo-opencode'],

  // Distinct from the bare opencode host so both can coexist on disk.
  globalRoot: '.config/opencode/skills/gstack-omo',
  localSkillRoot: '.opencode/skills/gstack-omo',
  hostSubdir: '.omo-opencode',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
    extraFields: {
      'omo-host': 'opencode',
    },
    conditionalFields: OMO_ROUTING.map((r) => ({
      if: { name: r.name },
      add: { 'omo-route': r.route },
    })),
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex', 'claude', 'openclaw', 'contrib'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.config/opencode/skills/gstack-omo' },
    { from: '.claude/skills/gstack',    to: '.opencode/skills/gstack-omo' },
    { from: '.claude/skills',           to: '.opencode/skills' },
  ],

  suppressedResolvers: [
    // OMO has its own subagent orchestration; suppress Claude-only review fanout
    // and Codex cross-invocation that would point at the wrong runtime.
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
      review: ['checklist.md', 'design-checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
  boundaryInstruction:
    'You are running inside OpenCode with the oh-my-openagent (omo) plugin loaded. ' +
    'Delegate to omo agents via the `task` tool with the category specified by `omo-route` ' +
    'in this skill\'s frontmatter. Do NOT shell out to `claude`, `codex`, or `droid` — those ' +
    'are different hosts. Stay inside the omo agent surface.',
};

export default omoOpencode;
