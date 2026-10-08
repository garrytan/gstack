/**
 * defineHost() factory — the single place the copy-paste across hosts/*.ts
 * used to live.
 *
 * Every field a host doesn't override gets the common external-host default:
 * tier 'experimental' with conservative capabilities (tool execution and
 * browser, prose questions, no plan mode, no delegation, advisory safety),
 * paths derived from the host name (`.{name}/skills/gstack`), allowlist
 * frontmatter (name + description), no metadata sidecar, all skills enabled,
 * the standard three-entry pathRewrite trio derived from the resolved
 * paths, the shared runtimeRoot asset list, and symlink-generated install.
 *
 * Defaults are constructed fresh per call, so no two host configs ever share
 * a mutable array/object. Optional fields that are absent today (toolRewrites,
 * coAuthorTrailer, boundaryInstruction) stay absent unless a host explicitly
 * sets them — the factory never default-populates optional fields.
 */

import type { HostConfig } from '../scripts/host-config';

type PathRewrite = { from: string; to: string };

/**
 * Preamble resolvers that orchestrate cross-model second opinions (they shell
 * out to the selected outside provider or spin up the review army). Suppressed
 * on the non-Claude agent runtimes that already opt out (OpenClaw, Hermes,
 * GBrain). Codex keeps the outside-provider resolvers and suppresses only army.
 */
export const CROSS_MODEL_RESOLVERS: string[] = [
  'DESIGN_OUTSIDE_VOICES',  // design.ts — selected outside provider
  'ADVERSARIAL_STEP',       // review.ts — adversarial outside review
  'CODEX_SECOND_OPINION',   // review.ts — legacy token, selected provider
  'CODEX_PLAN_REVIEW',      // review.ts — legacy token, selected provider
  'REVIEW_ARMY',            // review-army.ts — multi-model orchestration
];

/**
 * Brain-aware resolvers. Suppressed by default on every host — only hosts
 * that can run with a GBrain (hermes, gbrain) leave these active.
 */
export const GBRAIN_RESOLVERS: string[] = [
  'GBRAIN_CONTEXT_LOAD',
  'GBRAIN_SAVE_RESULTS',
];

/**
 * Tool-name rewrites for OpenClaw-style agent runtimes (lowercase exec /
 * read / write / edit tools, sessions_spawn for subagents). OpenClaw and
 * GBrain share these byte-for-byte; spread into `toolRewrites` at the use
 * site so each config owns its own copy.
 */
export const EXEC_STYLE_TOOL_REWRITES: Record<string, string> = {
  'use the Bash tool': 'use the exec tool',
  'use the Write tool': 'use the write tool',
  'use the Read tool': 'use the read tool',
  'use the Edit tool': 'use the edit tool',
  'use the Agent tool': 'use sessions_spawn',
  "Claude Code's Agent tool": 'sessions_spawn',
  'the Agent tool': 'sessions_spawn',
  'Agent tool': 'sessions_spawn',
  'use the Grep tool': 'search for',
  'use the Glob tool': 'find files matching',
  'the Bash tool': 'the exec tool',
  'the Read tool': 'the read tool',
  'the Write tool': 'the write tool',
  'the Edit tool': 'the edit tool',
};

/**
 * Prepend a one-paragraph tool-name glossary to the preamble's STATUS rules
 * (spread into `toolRewrites`). For hosts whose native tools differ from the
 * Claude names the shared prose uses; test/host-config.test.ts pins the anchor.
 */
export const PREAMBLE_GLOSSARY_ANCHOR = 'Read the echoed `KEY: value` STATUS lines';
export function preambleToolGlossary(glossary: string): Record<string, string> {
  return { [PREAMBLE_GLOSSARY_ANCHOR]: `${glossary}\n\n${PREAMBLE_GLOSSARY_ANCHOR}` };
}

/**
 * The runtime-root assets setup installs for every env-var host: the tools
 * the skills run plus every file they read as "$GSTACK_ROOT/<path>". Mirrors
 * setup's _link_runtime_dists and _copy_runtime_skill_refs (each root also
 * links bin, lib, browse and ETHOS.md); test/runtime-root-assets.test.ts
 * checks the staged roots on disk. `extraSymlinks` appends host-only assets.
 */
export function sharedRuntimeRoot(extraSymlinks: string[] = []): HostConfig['runtimeRoot'] {
  return {
    globalSymlinks: ['bin', 'lib', 'browse/dist', 'browse/bin', 'design/dist', 'make-pdf/dist', 'freeze/bin', 'careful/bin',
      'review/specialists', 'design-html/vendor', 'gstack-upgrade', 'ETHOS.md', 'VERSION', ...extraSymlinks],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
      'scripts': ['jargon-list.json', 'question-registry.ts'],
      'docs': ['askuserquestion-split.md', 'askuserquestion-cjk.md', 'test-value-bar.md'],
      'plan-devex-review': ['dx-hall-of-fame.md'],
      'office-hours': ['SKILL.md'],
      'plan-design-review': ['SKILL.md'],
    },
  };
}

/**
 * Host definition input: name + displayName are required, everything else is
 * an override on the common external-host defaults documented above.
 *
 * `extraPathRewrites` appends to the derived standard trio
 * (`~/.claude/skills/gstack` → `~/{globalRoot}`, `.claude/skills/gstack` →
 * localSkillRoot, `.claude/skills` → `{hostSubdir}/skills`). Hosts whose
 * rewrites aren't mechanically derivable (codex, factory use $GSTACK_ROOT and
 * an extra review rewrite; claude has none) replace the whole list via
 * `pathRewrites` instead. The two are mutually exclusive.
 */
export interface HostOverrides<N extends string = string>
  extends Partial<Omit<HostConfig, 'name' | 'displayName'>> {
  name: N;
  displayName: string;
  /** Appended after the derived pathRewrite trio. Mutually exclusive with `pathRewrites`. */
  extraPathRewrites?: PathRewrite[];
}

export function defineHost<const N extends string>(overrides: HostOverrides<N>): HostConfig & { name: N } {
  const {
    name,
    displayName,
    cliCommand = name,
    cliAliases = [],
    defaultModel = 'claude',
    tier = 'experimental',
    capabilities = {
      toolExecution: true,
      questions: 'prose',
      planMode: false,
      delegation: false,
      browser: true,
      safetyHooks: 'advisory',
    },
    globalRoot = `.${name}/skills/gstack`,
    localSkillRoot = `.${name}/skills/gstack`,
    hostSubdir = `.${name}`,
    usesEnvVars = true,  // false only for Claude (literal ~ paths, no $GSTACK_ROOT)
    frontmatter = {
      mode: 'allowlist',
      keepFields: ['name', 'description'],
      descriptionLimit: null,
    },
    generation = {
      generateMetadata: false,
      skipSkills: [],
    },
    pathRewrites,
    extraPathRewrites,
    toolRewrites,
    suppressedResolvers = [...GBRAIN_RESOLVERS],
    runtimeRoot = sharedRuntimeRoot(),
    install = {
      linkingStrategy: 'symlink-generated',
    },
    coAuthorTrailer,
    learningsMode = 'basic',
    boundaryInstruction,
  } = overrides;

  if (pathRewrites && extraPathRewrites) {
    throw new Error(
      `[${name}] pathRewrites and extraPathRewrites are mutually exclusive: ` +
      `pathRewrites replaces the derived trio, extraPathRewrites appends to it`
    );
  }

  const resolvedPathRewrites: PathRewrite[] = pathRewrites ?? [
    { from: '~/.claude/skills/gstack', to: `~/${globalRoot}` },
    { from: '.claude/skills/gstack', to: localSkillRoot },
    { from: '.claude/skills', to: `${hostSubdir}/skills` },
    ...(extraPathRewrites ?? []),
  ];

  // Field order below mirrors the HostConfig interface (and the original
  // hand-written configs) so serialized output is stable. Optional fields are
  // conditionally spread so absent overrides stay truly absent (no
  // `key: undefined` entries).
  return {
    name,
    displayName,
    cliCommand,
    cliAliases,
    defaultModel,
    tier,
    capabilities,
    globalRoot,
    localSkillRoot,
    hostSubdir,
    usesEnvVars,
    frontmatter,
    generation,
    pathRewrites: resolvedPathRewrites,
    ...(toolRewrites !== undefined ? { toolRewrites } : {}),
    suppressedResolvers,
    runtimeRoot,
    install,
    ...(coAuthorTrailer !== undefined ? { coAuthorTrailer } : {}),
    learningsMode,
    ...(boundaryInstruction !== undefined ? { boundaryInstruction } : {}),
  };
}
