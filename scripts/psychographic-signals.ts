/**
 * Psychographic Signal Map — hand-crafted {question_id, user_choice} → {dimension, delta}.
 *
 * Consumed in v1 ONLY to compute inferred dimension values for /plan-tune
 * inspection output. No skill behavior adapts to these signals in v1.
 *
 * When v2 wires 5 skills to consume the profile, this map is the source of
 * truth for how behavior influences dimensions. Calibration deltas in v1 are
 * best-guess starting points; v2 recalibrates from real observed data.
 *
 * Design principles
 * -----------------
 * 1. Hand-crafted, not agent-inferred (Codex #4, user Decision C).
 *    Every mapping is explicit TypeScript — no runtime NL interpretation.
 *
 * 2. Small, conservative deltas (±0.03 to ±0.06 typical).
 *    A single answer should nudge the profile, not reshape it. Repeated
 *    answers across sessions accumulate.
 *
 * 3. Tied to registry signal_key.
 *    Each entry in this map corresponds to a signal_key declared in
 *    scripts/question-registry.ts. The derivation pipeline uses the
 *    question's signal_key + user_choice as the lookup key.
 *
 * 4. Not every question contributes to every dimension.
 *    Many questions have no signal_key — they're logged but don't move
 *    the psychographic. Only questions that genuinely reveal preference
 *    get a signal_key.
 *
 * Dimensions
 * ----------
 *   scope_appetite:     0 = small-scope, ship fast  ↔  1 = boil the ocean
 *   risk_tolerance:     0 = conservative, ask first ↔  1 = move fast, auto-decide
 *   detail_preference:  0 = terse, just do it       ↔  1 = verbose, explain everything
 *   autonomy:           0 = hands-on, consult me    ↔  1 = delegate, trust the agent
 *   architecture_care:  0 = pragmatic, ship it      ↔  1 = principled, get it right
 */

import { QUESTIONS } from './question-registry';

/** The 5 dimensions of the developer psychographic. */
export type Dimension =
  | 'scope_appetite'
  | 'risk_tolerance'
  | 'detail_preference'
  | 'autonomy'
  | 'architecture_care';

export const ALL_DIMENSIONS: readonly Dimension[] = [
  'scope_appetite',
  'risk_tolerance',
  'detail_preference',
  'autonomy',
  'architecture_care',
] as const;

/**
 * Semantic version of the signal map. Increment when deltas change so that
 * cached profiles can detect staleness and recompute from events.
 */
export const SIGNAL_MAP_VERSION = '0.2.0';

export interface DimensionDelta {
  dim: Dimension;
  delta: number;
}

/**
 * Signal map: signal_key → user_choice → list of dimension nudges.
 *
 * Indexed by signal_key (declared in question-registry entries), not
 * question_id directly. This lets multiple questions share a semantic
 * pattern (e.g., scope-appetite signal comes from both plan-ceo-review
 * expansion proposals AND office-hours approach selection).
 */
export const SIGNAL_MAP: Record<string, Record<string, DimensionDelta[]>> = {
  // -----------------------------------------------------------------------
  // scope-appetite — how much the user likes to expand scope
  // -----------------------------------------------------------------------
  'scope-appetite': {
    // plan-ceo-review mode choice
    expand: [{ dim: 'scope_appetite', delta: +0.06 }],
    selective: [{ dim: 'scope_appetite', delta: +0.03 }],
    hold: [{ dim: 'scope_appetite', delta: -0.01 }],
    reduce: [{ dim: 'scope_appetite', delta: -0.06 }],
    // plan-ceo-review expansion proposal accepted/deferred/skipped
    accept: [{ dim: 'scope_appetite', delta: +0.04 }],
    defer: [{ dim: 'scope_appetite', delta: -0.01 }],
    skip: [{ dim: 'scope_appetite', delta: -0.03 }],
    // office-hours approach choice
    minimal: [{ dim: 'scope_appetite', delta: -0.04 }],
    ideal: [{ dim: 'scope_appetite', delta: +0.05 }],
    creative: [{ dim: 'scope_appetite', delta: +0.02 }],
  },

  // -----------------------------------------------------------------------
  // architecture-care — how much the user sweats the details
  // -----------------------------------------------------------------------
  'architecture-care': {
    'fix-now': [
      { dim: 'architecture_care', delta: +0.05 },
      { dim: 'risk_tolerance', delta: -0.02 },
    ],
    defer: [{ dim: 'architecture_care', delta: -0.02 }],
    'accept-risk': [
      { dim: 'architecture_care', delta: -0.04 },
      { dim: 'risk_tolerance', delta: +0.04 },
    ],
  },

  // -----------------------------------------------------------------------
  // code-quality-care — proxies detail_preference + architecture_care
  // -----------------------------------------------------------------------
  'code-quality-care': {
    'fix-now': [
      { dim: 'detail_preference', delta: +0.02 },
      { dim: 'architecture_care', delta: +0.03 },
    ],
    'ack-and-ship': [
      { dim: 'risk_tolerance', delta: +0.03 },
      { dim: 'architecture_care', delta: -0.02 },
    ],
    'false-positive': [{ dim: 'architecture_care', delta: +0.01 }],
    defer: [{ dim: 'architecture_care', delta: -0.02 }],
    skip: [{ dim: 'detail_preference', delta: -0.03 }],
  },

  // -----------------------------------------------------------------------
  // test-discipline — proxies architecture_care + detail_preference
  // -----------------------------------------------------------------------
  'test-discipline': {
    'fix-now': [
      { dim: 'architecture_care', delta: +0.04 },
      { dim: 'detail_preference', delta: +0.02 },
    ],
    investigate: [{ dim: 'architecture_care', delta: +0.02 }],
    'ack-and-ship': [
      { dim: 'risk_tolerance', delta: +0.04 },
      { dim: 'architecture_care', delta: -0.03 },
    ],
    'add-test': [
      { dim: 'architecture_care', delta: +0.03 },
      { dim: 'detail_preference', delta: +0.02 },
    ],
    defer: [{ dim: 'architecture_care', delta: -0.01 }],
    skip: [{ dim: 'architecture_care', delta: -0.04 }],
  },

  // -----------------------------------------------------------------------
  // detail-preference — direct signal for verbosity
  // -----------------------------------------------------------------------
  'detail-preference': {
    accept: [{ dim: 'detail_preference', delta: +0.03 }],
    skip: [{ dim: 'detail_preference', delta: -0.03 }],
  },

  // -----------------------------------------------------------------------
  // design-care — proxies architecture_care for UI-facing work
  // -----------------------------------------------------------------------
  'design-care': {
    expand: [{ dim: 'architecture_care', delta: +0.04 }],
    polish: [{ dim: 'architecture_care', delta: +0.02 }],
    triage: [{ dim: 'architecture_care', delta: -0.02 }],
    'fix-now': [{ dim: 'architecture_care', delta: +0.02 }],
    defer: [{ dim: 'architecture_care', delta: -0.01 }],
    skip: [{ dim: 'architecture_care', delta: -0.03 }],
  },

  // -----------------------------------------------------------------------
  // devex-care — DX is UX for developers; proxies architecture_care
  // -----------------------------------------------------------------------
  'devex-care': {
    expand: [{ dim: 'architecture_care', delta: +0.04 }],
    polish: [{ dim: 'architecture_care', delta: +0.02 }],
    triage: [{ dim: 'architecture_care', delta: -0.02 }],
    'fix-now': [{ dim: 'architecture_care', delta: +0.02 }],
    defer: [{ dim: 'architecture_care', delta: -0.01 }],
    skip: [{ dim: 'architecture_care', delta: -0.03 }],
  },

  // -----------------------------------------------------------------------
  // distribution-care — does the user care about how code reaches users?
  // -----------------------------------------------------------------------
  'distribution-care': {
    accept: [{ dim: 'architecture_care', delta: +0.03 }],
    defer: [{ dim: 'architecture_care', delta: -0.02 }],
    skip: [{ dim: 'architecture_care', delta: -0.04 }],
  },

  // -----------------------------------------------------------------------
  // decision-autonomy — does the user trust the agent to apply decisions
  // without checking back? (Cathedral T7: was the missing signal for the
  // 'autonomy' dimension; added so /plan-tune annotations can render
  // 'consult me' vs 'delegate' guidance on merge/rollback questions.)
  // -----------------------------------------------------------------------
  'decision-autonomy': {
    accept: [{ dim: 'autonomy', delta: +0.04 }],
    reject: [{ dim: 'autonomy', delta: -0.04 }],
    // common option keys for "I'll review first" vs "go ahead":
    'review-first': [{ dim: 'autonomy', delta: -0.05 }],
    proceed: [{ dim: 'autonomy', delta: +0.05 }],
    // /investigate-style: "agent applies fix" vs "show me the diff first"
    'apply-fix': [{ dim: 'autonomy', delta: +0.04 }],
    'show-diff': [{ dim: 'autonomy', delta: -0.04 }],
  },

  // -----------------------------------------------------------------------
  // session-mode — office-hours goal selection
  // -----------------------------------------------------------------------
  'session-mode': {
    startup: [
      { dim: 'scope_appetite', delta: +0.02 },
      { dim: 'architecture_care', delta: +0.02 },
    ],
    intrapreneur: [{ dim: 'scope_appetite', delta: +0.02 }],
    hackathon: [
      { dim: 'risk_tolerance', delta: +0.03 },
      { dim: 'architecture_care', delta: -0.02 },
    ],
    'oss-research': [{ dim: 'architecture_care', delta: +0.02 }],
    learning: [{ dim: 'detail_preference', delta: +0.02 }],
    fun: [{ dim: 'risk_tolerance', delta: +0.02 }],
  },
};

/**
 * Apply a user choice for a question to the running dimension totals.
 *
 * @param dims - running total of dimension nudges (mutated)
 * @param signal_key - from the question registry entry
 * @param user_choice - the option key the user selected
 * @returns list of dimension deltas applied (empty if no mapping)
 */
export function applySignal(
  dims: Record<Dimension, number>,
  signal_key: string,
  user_choice: string,
): DimensionDelta[] {
  const subMap = SIGNAL_MAP[signal_key];
  if (!subMap) return [];
  const deltas = subMap[user_choice];
  if (!deltas) return [];
  for (const { dim, delta } of deltas) {
    dims[dim] = (dims[dim] ?? 0) + delta;
  }
  return deltas;
}

/**
 * Validate that every signal_key referenced in the registry has a matching
 * entry in SIGNAL_MAP. Called by tests to catch drift.
 */
export function validateRegistrySignalKeys(): {
  missing: string[];
  extra: string[];
} {
  const registrySignalKeys = new Set<string>();
  for (const q of Object.values(QUESTIONS)) {
    if (q.signal_key) registrySignalKeys.add(q.signal_key);
  }
  const mapKeys = new Set(Object.keys(SIGNAL_MAP));
  const missing: string[] = [];
  const extra: string[] = [];
  for (const k of registrySignalKeys) {
    if (!mapKeys.has(k)) missing.push(k);
  }
  for (const k of mapKeys) {
    if (!registrySignalKeys.has(k)) extra.push(k);
  }
  return { missing, extra };
}

/** Empty dimension totals — starting point for derivation. */
export function newDimensionTotals(): Record<Dimension, number> {
  return {
    scope_appetite: 0,
    risk_tolerance: 0,
    detail_preference: 0,
    autonomy: 0,
    architecture_care: 0,
  };
}

/** Sigmoid clamp: map accumulated delta total to [0, 1]. */
export function normalizeToDimensionValue(total: number): number {
  // Simple sigmoid: each 1.0 of accumulated delta approaches saturation.
  // 0.5 is neutral. Positive deltas push toward 1, negative toward 0.
  return 1 / (1 + Math.exp(-total * 3));
}

// ---------------------------------------------------------------------------
// Registry-independent signal: followed_recommendation -> autonomy
// ---------------------------------------------------------------------------
//
// Why this exists
// ---------------
// SIGNAL_MAP attribution requires three exact-string matches to all land:
// question_id in QUESTIONS, that entry carrying a signal_key, and user_choice
// matching a key in SIGNAL_MAP[signal_key]. Measured on a real 1,286-row log,
// the third one matched ZERO rows -- the AskUserQuestion capture hook records
// the UI LABEL ("Restore the parallel typecheck job") while SIGNAL_MAP is keyed
// by stable option keys ('accept', 'expand', 'fix-now'), and the host's
// AskUserQuestion payload has no slot for a stable key. So every dimension sat
// at exactly 0.5 while sample_size read 1286 and every calibration gate passed.
//
// `followed_recommendation` is different: gstack-question-log computes it at
// write time from (user_choice, recommended), so it is already present on ~95%
// of rows and needs no registry entry, no marker, and no skill change. It is
// the only signal that can read existing history retroactively.
//
// Why the shape is O(1) and not a per-event delta
// -----------------------------------------------
// normalizeToDimensionValue is a sigmoid over an ACCUMULATED total, tuned for
// tens of signals. A per-event delta at this file's usual +/-0.03..0.06 would
// reach 0.9994 by 50 events and 1.0 by 100 -- as uninformative as the 0.5 it
// replaced. This contributes ONE bounded delta computed from the whole history.
//
// Honest calibration note
// -----------------------
// RECOMMENDATION_SIGNAL_WEIGHT is an unvalidated starting constant, in the
// spirit of this file's header ("v1 deltas are best-guess starting points").
// It was picked on ONE user's data because it lands near their declared value,
// which is post-hoc. It is also confounded: a high follow rate may measure how
// good the agent's recommendations are as much as how much the user delegates.
// Treat the output as a weak prior, not a measurement.

/** Weight of the recommendation-following signal. See the calibration note. */
export const RECOMMENDATION_SIGNAL_WEIGHT = 0.5;

/**
 * Eligible-row count at which the signal reaches full strength.
 *
 * Deliberately keyed on ELIGIBLE rows, not on `inferred.sample_size`. The
 * documented calibration gate (docs/designs/PLAN_TUNING_V0.md) reads
 * sample_size, which counts EVERY logged row -- so 3 eligible rows beside 1,200
 * unrelated ones passes that gate and would otherwise render a confident
 * autonomy score from three answers.
 */
export const RECOMMENDATION_MIN_SAMPLE = 20;

/** Minimal shape this signal reads off a question-log row. */
export interface RecommendationEvent {
  followed_recommendation?: unknown;
  source?: unknown;
  question_id?: unknown;
}

/**
 * True when a row's autonomy evidence is already counted by the registry path.
 *
 * PRECEDENCE: totals.autonomy is written by BOTH the per-event SIGNAL_MAP path
 * and this aggregate. A row can be a 'decision-autonomy' registry event AND
 * carry followed_recommendation, which would feed one decision into the
 * dimension twice. The more specific path wins; this one steps aside.
 */
function countedByRegistry(questionId: unknown): boolean {
  if (typeof questionId !== 'string') return false;
  const def = (QUESTIONS as Record<string, { signal_key?: string }>)[questionId];
  if (!def || !def.signal_key) return false;
  const deltas = SIGNAL_MAP[def.signal_key];
  if (!deltas) return false;
  for (const choiceDeltas of Object.values(deltas)) {
    for (const { dim } of choiceDeltas) {
      if (dim === 'autonomy') return true;
    }
  }
  return false;
}

/**
 * Rows this signal is allowed to read.
 *
 * question-log.jsonl is plain append-only JSONL that a user or a future writer
 * can hand-edit, so every clause below fails CLOSED on anything unexpected:
 *
 *  - followed_recommendation must be a STRICT boolean. The string "false" is
 *    truthy; a truthiness check would silently count it as a follow and bias
 *    autonomy upward with no error.
 *  - source must be PRESENT and not 'auto-decided'. gstack-question-log
 *    defaults source to 'agent' on write, so a row lacking it was never written
 *    by that binary. Excluding 'auto-decided' is load-bearing: the preference
 *    hook auto-picks the recommendation, which would otherwise feed "the user
 *    delegates" evidence straight back into the dimension that licenses
 *    auto-deciding.
 *  - the row must not already be counted by the registry path (see above).
 */
export function isRecommendationEligible(e: RecommendationEvent): boolean {
  if (typeof e.followed_recommendation !== 'boolean') return false;
  if (typeof e.source !== 'string' || e.source === 'auto-decided') return false;
  if (countedByRegistry(e.question_id)) return false;
  return true;
}

/**
 * Aggregate followed_recommendation across the whole log into ONE autonomy
 * delta.
 *
 * Laplace (add-one) smoothing on the rate, then a confidence ramp on the
 * eligible count:
 *
 *     smoothed   = (followed + 1) / (n + 2)
 *     confidence = min(1, n / RECOMMENDATION_MIN_SAMPLE)
 *     delta      = WEIGHT * confidence * (2 * smoothed - 1)
 *
 * Smoothing returns exactly 0.5 at n = 0, so "no eligible rows" needs no
 * special case: it yields delta 0, which the sigmoid renders as neutral.
 */
export function recommendationSignal(
  events: readonly RecommendationEvent[],
): DimensionDelta {
  let followed = 0;
  let n = 0;
  for (const e of events) {
    if (!isRecommendationEligible(e)) continue;
    n += 1;
    if (e.followed_recommendation === true) followed += 1;
  }
  const smoothed = (followed + 1) / (n + 2);
  const confidence = Math.min(1, n / RECOMMENDATION_MIN_SAMPLE);
  const delta = RECOMMENDATION_SIGNAL_WEIGHT * confidence * (2 * smoothed - 1);
  return { dim: 'autonomy', delta };
}

/** Eligible-row count, for provenance reporting. Counts UNIQUE ROWS. */
export function recommendationEligibleCount(
  events: readonly RecommendationEvent[],
): number {
  let n = 0;
  for (const e of events) if (isRecommendationEligible(e)) n += 1;
  return n;
}
