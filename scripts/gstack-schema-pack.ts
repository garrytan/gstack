/**
 * gstack-core@1.0.0 schema pack (T1 / Phase 0).
 *
 * Defines the 7 typed page kinds gstack writes into a personal gbrain:
 *   gstack/user-profile, gstack/product, gstack/goal, gstack/developer-persona,
 *   gstack/brand, gstack/competitive-intel, gstack/skill-run
 *
 * Plus the typed take kind gstack writes for Phase 2 calibration:
 *   gstack/take (kind=bet, holder=<user>, with expected_resolution_date)
 *
 * Exports JSON consumed by `mcp__gbrain__schema_apply_mutations` at first
 * /setup-gbrain or /sync-gbrain after this lands. Registration is idempotent
 * (gbrain's mutation handler skips re-registration when pack version matches).
 *
 * Each type carries frontmatter shape + link types. Link inference enables
 * `mcp__gbrain__schema_graph` to render the gstack subgraph correctly.
 */

import {
  GSTACK_SCHEMA_PACK_NAME,
  GSTACK_SCHEMA_PACK_VERSION,
} from './brain-cache-spec';

export interface SchemaFieldShape {
  name: string;
  type: 'string' | 'date' | 'number' | 'enum' | 'wikilink-array' | 'string-array';
  required: boolean;
  /** For enum types. */
  values?: ReadonlyArray<string>;
  description: string;
}

export interface SchemaTypeDefinition {
  /** Page type slug, e.g. `gstack/product`. */
  type: string;
  /** Human-readable purpose. Surfaces in `mcp__gbrain__schema_explain_type`. */
  description: string;
  /** Per-page-type retention semantics; 'immutable' means never auto-archive. */
  retention: 'immutable' | 'archive-after-90d' | 'never-archive';
  /** Frontmatter fields the page MUST or MAY carry. */
  fields: ReadonlyArray<SchemaFieldShape>;
  /**
   * Link types this page emits via `[[wikilink]]` references in body or
   * frontmatter. Used by gbrain's link inference + schema_graph rendering.
   */
  emits_links?: ReadonlyArray<{ verb: string; target_type: string }>;
}

export interface SchemaPackJSON {
  name: string;
  version: string;
  page_types: ReadonlyArray<SchemaTypeDefinition>;
  link_verbs: ReadonlyArray<string>;
}

/* ────────────────────────────────────────────────────────────────── */
/* Page type definitions                                              */
/* ────────────────────────────────────────────────────────────────── */

const USER_PROFILE: SchemaTypeDefinition = {
  type: 'gstack/user-profile',
  description:
    'Cross-project profile of the gstack user: tone/conviction patterns, ' +
    'decision tendencies, calibration profile reference. One per user identity. ' +
    'Read by all planning skills for tone-aware + bias-aware recommendations.',
  retention: 'never-archive',
  fields: [
    { name: 'type', type: 'string', required: true, description: 'gstack/user-profile' },
    { name: 'slug', type: 'string', required: true, description: 'gstack/user-profile/<user-slug>' },
    { name: 'user_slug', type: 'string', required: true, description: 'Resolved per USER_SLUG_RESOLUTION_ORDER' },
    { name: 'last_updated_by', type: 'string', required: false, description: 'Last skill that touched this page' },
    { name: 'last_updated_at', type: 'date', required: false, description: 'ISO-8601 datetime' },
    { name: 'pattern_statements', type: 'string-array', required: false, description: 'Bias tags from calibration (e.g., "under-expands on infra plans")' },
    { name: 'taste_signals', type: 'string-array', required: false, description: 'Recurring design/eng preferences observed across reviews' },
  ],
  emits_links: [
    { verb: 'has_calibration', target_type: 'gstack/take' },
  ],
};

const PRODUCT: SchemaTypeDefinition = {
  type: 'gstack/product',
  description:
    'Per-project product model: what the product IS today (value prop, target user, ' +
    'stage, team), with active goals + recent decisions. Single source of truth ' +
    'every planning skill consults before asking the user about their product.',
  retention: 'never-archive',
  fields: [
    { name: 'type', type: 'string', required: true, description: 'gstack/product' },
    { name: 'slug', type: 'string', required: true, description: 'gstack/product/<project-slug>' },
    { name: 'title', type: 'string', required: true, description: 'Project / product name' },
    { name: 'last_updated_by', type: 'string', required: false, description: '/office-hours or /plan-ceo-review' },
    { name: 'last_updated_at', type: 'date', required: false, description: 'ISO-8601' },
    { name: 'status', type: 'enum', required: true, values: ['active', 'paused', 'archived'], description: 'Project status' },
  ],
  emits_links: [
    { verb: 'targets', target_type: 'gstack/goal' },
    { verb: 'observed_by', target_type: 'gstack/developer-persona' },
    { verb: 'has_brand', target_type: 'gstack/brand' },
    { verb: 'competes_with', target_type: 'gstack/competitive-intel' },
    { verb: 'history', target_type: 'gstack/skill-run' },
  ],
};

const GOAL: SchemaTypeDefinition = {
  type: 'gstack/goal',
  description:
    'A time-bounded outcome the user has committed to (ship X by Y, hit metric Z). ' +
    'Multiple active goals per project. Auto-flips to status=expired when ' +
    'expected_resolution date passes; preflight surfaces expired goals for review.',
  retention: 'never-archive',
  fields: [
    { name: 'type', type: 'string', required: true, description: 'gstack/goal' },
    { name: 'slug', type: 'string', required: true, description: 'gstack/goal/<project-slug>/<goal-id>' },
    { name: 'title', type: 'string', required: true, description: 'One-line goal statement' },
    { name: 'project', type: 'string', required: true, description: 'project slug' },
    { name: 'committed_at', type: 'date', required: true, description: 'When the user committed' },
    { name: 'expected_resolution', type: 'date', required: false, description: 'ISO-8601; flips to expired after' },
    { name: 'status', type: 'enum', required: true, values: ['active', 'resolved', 'expired', 'archived'], description: 'Lifecycle state' },
    { name: 'resolution_note', type: 'string', required: false, description: 'Filled when resolved' },
  ],
  emits_links: [
    { verb: 'belongs_to', target_type: 'gstack/product' },
  ],
};

const DEVELOPER_PERSONA: SchemaTypeDefinition = {
  type: 'gstack/developer-persona',
  description:
    'Per-project model of the target developer using this product (when product ' +
    'is developer-facing). Captures persona, friction patterns, prior TTHW ' +
    'measurements. Read by devex + design skills for calibrated recommendations.',
  retention: 'never-archive',
  fields: [
    { name: 'type', type: 'string', required: true, description: 'gstack/developer-persona' },
    { name: 'slug', type: 'string', required: true, description: 'gstack/developer-persona/<project-slug>' },
    { name: 'persona', type: 'string', required: true, description: 'One-line target developer description' },
    { name: 'tthw_measurements', type: 'string-array', required: false, description: 'Historical TTHW times with dates' },
    { name: 'friction_patterns', type: 'string-array', required: false, description: 'Where developers get stuck' },
  ],
};

const BRAND: SchemaTypeDefinition = {
  type: 'gstack/brand',
  description:
    "Per-project brand voice: visual direction, design language, tone-of-voice. " +
    'Read by design skills + devex skills (for consistency checks across CLI/docs/UI).',
  retention: 'never-archive',
  fields: [
    { name: 'type', type: 'string', required: true, description: 'gstack/brand' },
    { name: 'slug', type: 'string', required: true, description: 'gstack/brand/<project-slug>' },
    { name: 'aesthetic', type: 'string', required: false, description: 'e.g., "minimal/typographic"' },
    { name: 'typography', type: 'string', required: false, description: 'Font system summary' },
    { name: 'color_system', type: 'string', required: false, description: 'Palette summary' },
    { name: 'voice', type: 'string', required: false, description: 'Tone of writing' },
  ],
};

const COMPETITIVE_INTEL: SchemaTypeDefinition = {
  type: 'gstack/competitive-intel',
  description:
    'Per-project competitive landscape: incumbents, indirect substitutes, measured ' +
    'competitor benchmarks (TTHW, pricing, feature parity). Read by CEO + devex.',
  retention: 'never-archive',
  fields: [
    { name: 'type', type: 'string', required: true, description: 'gstack/competitive-intel' },
    { name: 'slug', type: 'string', required: true, description: 'gstack/competitive-intel/<project-slug>' },
    { name: 'competitors', type: 'string-array', required: false, description: 'Named competitors with positioning notes' },
    { name: 'benchmarks', type: 'string-array', required: false, description: 'Measured comparison points (TTHW etc.)' },
  ],
};

const SKILL_RUN: SchemaTypeDefinition = {
  type: 'gstack/skill-run',
  description:
    'Every gstack skill invocation that produces output writes one of these on completion. ' +
    'Time-series log of decisions, modes, mode-selected, outcomes. Powers /retro ' +
    'and (deferred) /gstack-reflect. Auto-archives to summary-only after 90 days.',
  retention: 'archive-after-90d',
  fields: [
    { name: 'type', type: 'string', required: true, description: 'gstack/skill-run' },
    { name: 'slug', type: 'string', required: true, description: 'gstack/skill-run/<project>/<skill>/<timestamp>' },
    { name: 'skill', type: 'string', required: true, description: 'Skill name (e.g., plan-ceo-review)' },
    { name: 'project', type: 'string', required: true, description: 'Project slug' },
    { name: 'branch', type: 'string', required: false, description: 'Git branch' },
    { name: 'commit', type: 'string', required: false, description: 'Short SHA' },
    { name: 'duration_s', type: 'number', required: false, description: 'Skill duration in seconds' },
    { name: 'outcome', type: 'enum', required: true, values: ['success', 'error', 'aborted'], description: 'Completion state' },
    { name: 'mode', type: 'string', required: false, description: 'Mode chosen (for skills with mode)' },
    { name: 'decisions', type: 'number', required: false, description: 'Count of AUQ decisions' },
    { name: 'takes_written', type: 'number', required: false, description: 'Calibration bets written (E5)' },
  ],
  emits_links: [
    { verb: 'related_to', target_type: 'gstack/product' },
    { verb: 'related_to', target_type: 'gstack/goal' },
    { verb: 'writes_bet', target_type: 'gstack/take' },
  ],
};

const TAKE: SchemaTypeDefinition = {
  type: 'gstack/take',
  description:
    'Typed predictions (kind=bet) written by planning skills (Phase 2 / E5). ' +
    'Resolved bets feed the user-profile calibration. Never auto-archived.',
  retention: 'never-archive',
  fields: [
    { name: 'type', type: 'string', required: true, description: 'gstack/take' },
    { name: 'slug', type: 'string', required: true, description: 'gstack/take/<project>/<date>/<id>' },
    { name: 'kind', type: 'enum', required: true, values: ['bet', 'hunch', 'fact', 'event'], description: 'Take kind' },
    { name: 'holder', type: 'string', required: true, description: 'User identity (whoami / user-slug)' },
    { name: 'claim', type: 'string', required: true, description: 'The prediction text' },
    { name: 'weight', type: 'number', required: false, description: '0-1 confidence (per-skill from SKILL_CALIBRATION_WEIGHTS)' },
    { name: 'since_date', type: 'date', required: false, description: 'When the take was written' },
    { name: 'expected_resolution', type: 'date', required: false, description: 'Target resolution date' },
    { name: 'resolved_at', type: 'date', required: false, description: 'When marked resolved' },
    { name: 'resolved_quality', type: 'enum', required: false, values: ['correct', 'incorrect', 'partial'], description: 'Calibration outcome' },
    { name: 'source_skill', type: 'string', required: false, description: 'Which skill wrote this bet' },
  ],
  emits_links: [
    { verb: 'belongs_to', target_type: 'gstack/user-profile' },
    { verb: 'origin', target_type: 'gstack/skill-run' },
  ],
};

/* ────────────────────────────────────────────────────────────────── */
/* Schema pack assembly                                               */
/* ────────────────────────────────────────────────────────────────── */

export const GSTACK_CORE_SCHEMA_PACK: SchemaPackJSON = {
  name: GSTACK_SCHEMA_PACK_NAME,
  version: GSTACK_SCHEMA_PACK_VERSION,
  page_types: [
    USER_PROFILE,
    PRODUCT,
    GOAL,
    DEVELOPER_PERSONA,
    BRAND,
    COMPETITIVE_INTEL,
    SKILL_RUN,
    TAKE,
  ],
  // Link verbs surface in mcp__gbrain__schema_graph as edge labels.
  link_verbs: [
    'has_calibration',
    'targets',
    'observed_by',
    'has_brand',
    'competes_with',
    'history',
    'belongs_to',
    'related_to',
    'writes_bet',
    'origin',
  ],
};

/**
 * Returns the JSON shape gbrain's `schema_apply_mutations` MCP op expects.
 * Idempotent on the brain side: gbrain skips re-registration when pack+version match.
 */
export function getSchemaPackMutationPayload(): {
  schema_pack: SchemaPackJSON;
  schema_version: number;
} {
  return {
    schema_pack: GSTACK_CORE_SCHEMA_PACK,
    schema_version: 1, // gbrain mutation API version, not pack version
  };
}

/** Returns just the page type names. Used by tests + audit subcommand. */
export function getSchemaPackTypeNames(): ReadonlyArray<string> {
  return GSTACK_CORE_SCHEMA_PACK.page_types.map((t) => t.type);
}

/** Returns the retention policy for a given page type. Throws on unknown. */
export function getRetentionPolicy(pageType: string): SchemaTypeDefinition['retention'] {
  const def = GSTACK_CORE_SCHEMA_PACK.page_types.find((t) => t.type === pageType);
  if (!def) throw new Error(`Unknown page type: ${pageType}`);
  return def.retention;
}
