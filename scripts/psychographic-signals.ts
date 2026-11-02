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

import { QUESTIONS, type QuestionDef } from './question-registry';

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
 * Label cues: option key → leading words of UI labels that mean that key.
 *
 * The AskUserQuestion hook only sees the label the user clicked ("A) Fix it
 * now (recommended)"), never a stable key, while SIGNAL_MAP is keyed by the
 * registry's option keys (#2623). resolveOptionKey() maps a label back to a
 * key when bin/gstack-question-log records a hook event. Every key also
 * matches its own words ("fix-now" → "fix now"), so only phrasings beyond
 * that need an entry here. Cues are
 * lowercase words separated by single spaces and match at the start of the
 * normalized label; candidates are limited to the question's own registered
 * options, and the longest cue wins.
 */
const OPTION_LABEL_CUES: Record<string, readonly string[]> = {
  accept: ['yes', 'approve', 'agree', 'add', 'include', 'apply', 'adopt', 'enable', 'go ahead', 'do it', 'proceed', 'run', 'create', 'merge', 'roll back', 'migrate', 'open', 'promote', 'reorganize', 'polish'],
  reject: ['no', 'disagree', 'decline', 'cancel', 'abort', 'dont', 'do not', 'keep current', 'keep as is', 'keep it as is'],
  skip: ['no', 'no thanks', 'not now', 'dont', 'do not', 'pass', 'drop', 'ignore', 'leave it', 'ship as is', 'ship it as is'],
  defer: ['later', 'fix later', 'add to todos', 'add to todo', 'add a todo', 'todo', 'postpone', 'backlog', 'park', 'track it'],
  'fix-now': ['fix', 'fix it', 'fix them', 'fix before shipping'],
  'fix-anyway': ['fix', 'fix it'],
  investigate: ['dig in', 'look into', 'debug', 'diagnose', 'root cause'],
  'ack-and-ship': ['ack', 'acknowledge', 'ship', 'ship anyway', 'ship it'],
  'accept-risk': ['accept', 'accept the risk', 'live with it'],
  'false-positive': ['not a bug', 'mark false positive', 'mark as false positive', 'mark it false positive'],
  'add-test': ['add', 'add tests', 'add the test', 'write', 'write the test', 'test it'],
  expand: ['scope expansion'],
  selective: ['cherry pick', 'selective expansion'],
  hold: ['keep', 'keep scope', 'hold scope'],
  reduce: ['cut', 'trim', 'shrink', 'scope down', 'scope reduction'],
  revise: ['edit', 'change', 'rework'],
  restart: ['start over', 'redo'],
  'build-now': ['build', 'build it now', 'include in this pr'],
  'keep-local': ['keep'],
  'keep-vendored': ['keep'],
  'yes-upgrade': ['yes', 'upgrade'],
  'always-auto': ['always'],
  'not-now': ['later', 'snooze'],
  'never-ask': ['never', 'disable'],
};

function normalizeOptionLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s*\(recommended\)\s*$/, '')
    .replace(/['\u2019]/g, '')
    .replace(/^\s*(?:option\s+)?[a-z0-9]\s*(?:[).:]|-(?=\s))\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Map a chosen UI label to the registered option key of its question.
 *
 * Returns the key when exactly one of the question's registered options
 * matches with the longest cue; undefined for unregistered ids, questions
 * without options, unmatched labels and ties, so an unclear answer stays
 * unmapped instead of nudging the wrong dimension.
 */
export function resolveOptionKey(question_id: string, choice: string): string | undefined {
  const options = (QUESTIONS as Record<string, QuestionDef>)[question_id]?.options as string[] | undefined;
  if (!options?.length) return undefined;
  if (options.includes(choice)) return choice;
  const label = normalizeOptionLabel(choice);
  if (!label) return undefined;
  let best: string | undefined;
  let bestWords = 0;
  let tie = false;
  for (const key of options) {
    for (const cue of [key.replace(/-/g, ' '), ...(OPTION_LABEL_CUES[key] ?? [])]) {
      if (label !== cue && !label.startsWith(cue + ' ')) continue;
      const words = cue.split(' ').length;
      if (words > bestWords) {
        best = key;
        bestWords = words;
        tie = false;
      } else if (words === bestWords && best !== key) {
        tie = true;
      }
    }
  }
  return tie ? undefined : best;
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
  for (const q of Object.values(QUESTIONS) as QuestionDef[]) {
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

/** Sigmoid clamp: map accumulated delta total to [0, 1]. */
export function normalizeToDimensionValue(total: number): number {
  // Simple sigmoid: each 1.0 of accumulated delta approaches saturation.
  // 0.5 is neutral. Positive deltas push toward 1, negative toward 0.
  return 1 / (1 + Math.exp(-total * 3));
}
