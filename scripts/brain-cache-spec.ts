/**
 * Brain cache spec — single source of truth for the brain-aware planning skills
 * cache layer. Imported by:
 *   - scripts/resolvers/gbrain.ts (renders per-skill subset into SKILL.md.tmpl)
 *   - bin/gstack-brain-cache (drives TTL + write-back invalidation)
 *   - test/brain-cache-spec.test.ts (asserts internal consistency)
 *   - test/skill-preflight-budget.test.ts (enforces per-skill token budget)
 *   - test/autoplan-preflight-budget.test.ts (enforces autoplan total budget)
 *
 * Drift between docs and runtime is impossible by construction: the same
 * const drives both the rendered table in SKILL.md and the cache CLI behavior.
 */

export interface BrainCacheEntity {
  /** Filename inside ~/.gstack/{,projects/<slug>/}brain-cache/ */
  file: string;
  /** Time-to-live in milliseconds before cache is considered stale and triggers cold refresh. */
  ttl_ms: number;
  /** Scope determines which dir holds the cache file. */
  scope: 'cross-project' | 'per-project';
  /**
   * Which write-paths invalidate this digest. When a writer runs, it consults
   * this list to know which cache files to bust. Special values:
   *   - 'calibration-write' — any Phase 2 takes_add call
   *   - 'skill-run-write'   — any skill that writes a gstack/skill-run page
   * Otherwise these are skill names like '/plan-ceo-review'.
   */
  invalidated_by: ReadonlyArray<string>;
  /** Hard byte budget for the digest. Compressor drops oldest items if exceeded. */
  budget_bytes: number;
}

/**
 * The seven cached entities mirror the seven typed page kinds in
 * `gstack-core` schema pack v1.0.0 (Phase 0):
 *   user-profile, product, goal, developer-persona, brand, competitive-intel, skill-run
 * Plus two derived digests:
 *   recent-decisions (top 5 gstack/skill-run pages)
 *   salience (mcp__gbrain__get_recent_salience output)
 */
export const BRAIN_CACHE_ENTITIES: Record<string, BrainCacheEntity> = {
  'user-profile': {
    file: 'user-profile.md',
    ttl_ms: 7 * 86_400_000, // 7 days
    scope: 'cross-project',
    invalidated_by: ['/retro', '/plan-tune', 'calibration-write'],
    budget_bytes: 2048,
  },
  product: {
    file: 'product.md',
    ttl_ms: 1 * 86_400_000, // 1 day
    scope: 'per-project',
    invalidated_by: ['/office-hours', '/plan-ceo-review'],
    budget_bytes: 1024,
  },
  goals: {
    file: 'goals.md',
    ttl_ms: 12 * 3_600_000, // 12 hours
    scope: 'per-project',
    invalidated_by: ['/office-hours', '/plan-ceo-review'],
    budget_bytes: 512,
  },
  'developer-persona': {
    file: 'developer-persona.md',
    ttl_ms: 7 * 86_400_000,
    scope: 'per-project',
    invalidated_by: ['/plan-devex-review', '/devex-review'],
    budget_bytes: 1024,
  },
  brand: {
    file: 'brand.md',
    ttl_ms: 7 * 86_400_000,
    scope: 'per-project',
    invalidated_by: ['/design-consultation', '/plan-design-review'],
    budget_bytes: 1024,
  },
  'competitive-intel': {
    file: 'competitive-intel.md',
    ttl_ms: 1 * 86_400_000,
    scope: 'per-project',
    invalidated_by: ['/plan-ceo-review', '/office-hours'],
    budget_bytes: 1024,
  },
  'recent-decisions': {
    file: 'recent-decisions.md',
    ttl_ms: 12 * 3_600_000,
    scope: 'per-project',
    invalidated_by: ['skill-run-write'],
    budget_bytes: 2048,
  },
  salience: {
    file: 'salience.md',
    ttl_ms: 4 * 3_600_000, // 4 hours
    scope: 'per-project',
    invalidated_by: [],
    budget_bytes: 512,
  },
};

/**
 * Per-skill subset map. The resolver consumes this to emit per-skill BRAIN_PREFLIGHT
 * instructions. The skill template loads ONLY the listed digests — never more.
 * Order matters for narrative coherence in the injected ## Brain Context block.
 *
 * Hard token budget per skill (validated by test/skill-preflight-budget.test.ts):
 *   - CEO/office-hours: 5 KB (richest context need)
 *   - eng/design/devex: 2 KB
 */
export const SKILL_DIGEST_SUBSETS: Record<string, ReadonlyArray<string>> = {
  'office-hours': ['product', 'goals', 'user-profile', 'recent-decisions', 'salience'],
  'plan-ceo-review': ['product', 'goals', 'recent-decisions', 'user-profile'],
  'plan-eng-review': ['product', 'recent-decisions'],
  'plan-design-review': ['product', 'brand', 'recent-decisions'],
  'plan-devex-review': ['product', 'developer-persona', 'recent-decisions', 'competitive-intel'],
};

/** Per-skill total digest budget (sum of loaded digests must not exceed). */
export const SKILL_PREFLIGHT_BUDGET_BYTES: Record<string, number> = {
  'office-hours': 5120,
  'plan-ceo-review': 5120,
  'plan-eng-review': 2048,
  'plan-design-review': 2048,
  'plan-devex-review': 2048,
};

/**
 * Total budget across an autoplan run (4 sequential planning skills). Validated by
 * test/autoplan-preflight-budget.test.ts. If a future autoplan-extended adds skills,
 * this cap forces an explicit budget revisit.
 */
export const AUTOPLAN_PREFLIGHT_BUDGET_BYTES = 25_600;

/**
 * D9 salience privacy: default allowlist of slug prefixes that are safe to surface
 * in planning prompts. Anything outside (personal/, family/, therapy/, etc.)
 * gets stripped at digest write time. User can extend via
 * `gstack-config set salience_allowlist '<comma-separated-prefixes>'`.
 */
export const SALIENCE_DEFAULT_ALLOWLIST: ReadonlyArray<string> = [
  'projects/',
  'concepts/',
  'gstack/',
];

/**
 * Per-skill calibration bet weights (Phase 2 / E5). When a planning skill writes
 * a kind=bet take, the weight determines how strongly it factors into the user's
 * calibration profile. Higher = more confident prediction worth more credit/blame
 * on resolution.
 */
export const SKILL_CALIBRATION_WEIGHTS: Record<string, number> = {
  'plan-ceo-review': 0.8,
  'plan-eng-review': 0.7,
  'plan-design-review': 0.5,
  'plan-devex-review': 0.6,
  'office-hours': 0.9,
};

/**
 * Lock-file path used by the cache refresh dedup (D3). Per-project to avoid
 * cross-project contention. Stale-takeover after 5 minutes.
 */
export const CACHE_REFRESH_LOCK_TIMEOUT_MS = 5 * 60_000;

/**
 * Retention policy: gstack/skill-run pages auto-archive after this many days.
 * Calibration takes (kind=bet) NEVER archive (long-term scorecard needs them).
 */
export const SKILL_RUN_RETENTION_DAYS = 90;

/**
 * Schema pack identity. Bumped when adding/removing/renaming page types.
 * On mismatch with the version recorded in _meta.json, the cache layer
 * triggers a FULL rebuild for the affected project.
 */
export const GSTACK_SCHEMA_PACK_NAME = 'gstack-core';
export const GSTACK_SCHEMA_PACK_VERSION = '1.0.0';

/**
 * Trust policy values. Drives auto-push of artifacts, calibration write-back
 * eligibility, and user-namespacing strategy.
 */
export type BrainTrustPolicy = 'personal' | 'shared' | 'unset';

/**
 * Per-transport default policy. Local engines auto-set to personal (single-tenant
 * by construction). Remote endpoints are inferred based on sources_list shape:
 * exactly one source + whoami matches → personal default; multiple sources or
 * federation → ask the policy question.
 */
export const TRANSPORT_DEFAULT_POLICY: Record<string, BrainTrustPolicy | 'infer'> = {
  'local-pglite': 'personal',
  'local-stdio': 'personal',
  'remote-http-single-tenant': 'personal',
  'remote-http-ambiguous': 'unset',
  unknown: 'unset',
};

/**
 * User-slug fallback chain (D4 A3 defensive default). Resolved once per endpoint
 * and persisted via `gstack-config set user_slug_at_<endpoint-hash> <slug>`.
 * Stable across sessions.
 */
export const USER_SLUG_RESOLUTION_ORDER = [
  'whoami_client_name', // mcp__gbrain__whoami.client_name (remote + OAuth)
  'env_user', // $USER environment variable
  'git_email_sha8', // sha8($(git config user.email))
  'anonymous_hostname_sha8', // anonymous-<sha8(hostname)>
] as const;

/** ----------------------------------------------------------------------- */
/** Helper functions consumed by the resolver, cache CLI, and tests.        */
/** ----------------------------------------------------------------------- */

/** Returns the cache filename for an entity name, throws if unknown. */
export function getCacheFile(entityName: string): string {
  const entity = BRAIN_CACHE_ENTITIES[entityName];
  if (!entity) throw new Error(`Unknown brain cache entity: ${entityName}`);
  return entity.file;
}

/** Returns the digest subset for a skill, throws if the skill isn't preflight-enabled. */
export function getSkillSubset(skillName: string): ReadonlyArray<string> {
  const subset = SKILL_DIGEST_SUBSETS[skillName];
  if (!subset) throw new Error(`Skill not registered for brain preflight: ${skillName}`);
  return subset;
}

/** Returns the per-skill total digest budget in bytes. */
export function getSkillBudget(skillName: string): number {
  const budget = SKILL_PREFLIGHT_BUDGET_BYTES[skillName];
  if (budget == null) throw new Error(`Skill not registered for brain preflight: ${skillName}`);
  return budget;
}

/**
 * Given a write-path identifier (skill name or special token), returns the list
 * of cache files that should be invalidated. Drives the cache CLI's `invalidate`
 * subcommand and the resolver's BRAIN_WRITE_BACK block.
 */
export function getInvalidationTargets(writePath: string): ReadonlyArray<string> {
  const targets: string[] = [];
  for (const [name, entity] of Object.entries(BRAIN_CACHE_ENTITIES)) {
    if (entity.invalidated_by.includes(writePath)) {
      targets.push(name);
    }
  }
  return targets;
}

/**
 * Lists all skill names that are registered for brain preflight. Used by
 * test/brain-preflight.test.ts and test/skill-preflight-budget.test.ts to
 * iterate without hardcoding the skill list.
 */
export function getPreflightSkills(): ReadonlyArray<string> {
  return Object.keys(SKILL_DIGEST_SUBSETS);
}

/**
 * Computes the maximum possible digest set size for a skill (sum of per-entity
 * budgets in the subset). Used by skill-preflight-budget.test.ts to validate
 * that the per-skill cap is enforceable given the per-entity caps.
 */
export function getMaxSubsetBytes(skillName: string): number {
  const subset = getSkillSubset(skillName);
  return subset.reduce((sum, name) => sum + (BRAIN_CACHE_ENTITIES[name]?.budget_bytes ?? 0), 0);
}
