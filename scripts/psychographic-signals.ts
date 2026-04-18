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
export const SIGNAL_MAP_VERSION = '0.1.0';

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
