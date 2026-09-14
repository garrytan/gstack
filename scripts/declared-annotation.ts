/**
 * Declared-profile annotation helper (plan-tune cathedral T7).
 *
 * Given a kebab signal_key from scripts/question-registry.ts, returns a
 * one-line plain-English annotation when the user's declared profile is in
 * a strong band on the matching dimension, else null. Read-only — never
 * mutates the profile.
 *
 * Signature uses kebab signal_key per D2/Codex correction. Internally maps
 * to the underscore Dimension key by consulting SIGNAL_MAP and picking the
 * dimension this signal influences most strongly.
 *
 * Used by:
 *   - hosts/claude/hooks/question-preference-hook (Layer 3 injection path,
 *     when AUQ mutation lands)
 *   - scripts/resolvers/question-tuning.ts preamble (Layer 9 fallback,
 *     host-portable path on Codex / older Claude Code)
 *
 * NOT used for AUTO_DECIDE. Annotation is advisory only — declared-only
 * per TODOS.md E1 substrate-risk guidance. Inferred-driven AUTO_DECIDE
 * remains v2.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SIGNAL_MAP, type Dimension, ALL_DIMENSIONS } from './psychographic-signals';

const STRONG_HIGH = 0.7;
const STRONG_LOW = 0.3;

/**
 * Plain-English phrasing per dimension + band. Keep one sentence each.
 * Used directly in question prose, so phrasing matters.
 */
const DIMENSION_PHRASING: Record<Dimension, { high: string; low: string }> = {
  scope_appetite: {
    high: 'Your declared profile leans complete-implementation (boil the ocean).',
    low: 'Your declared profile leans ship-small-fast.',
  },
  risk_tolerance: {
    high: 'Your declared profile leans move-fast.',
    low: 'Your declared profile leans check-carefully.',
  },
  detail_preference: {
    high: 'Your declared profile leans verbose-with-tradeoffs.',
    low: 'Your declared profile leans terse, just-do-it.',
  },
  autonomy: {
    high: 'Your declared profile leans delegate-and-trust.',
    low: 'Your declared profile leans consult-me-first.',
  },
  architecture_care: {
    high: 'Your declared profile leans get-the-design-right.',
    low: 'Your declared profile leans pragmatic-ship-it.',
  },
};

interface DeveloperProfile {
  declared?: Partial<Record<Dimension, number>>;
}

function stateRoot(): string {
  return (
    process.env.GSTACK_STATE_ROOT ||
    process.env.GSTACK_HOME ||
    path.join(os.homedir(), '.gstack')
  );
}

function readProfile(): DeveloperProfile | null {
  try {
    const p = path.join(stateRoot(), 'developer-profile.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Determine which dimension a signal_key influences most strongly.
 * Sums |delta| across all user_choice → DimensionDelta[] entries for that
 * signal, returns the dimension with the largest total influence.
 * Returns null if the signal_key isn't in the map.
 */
export function primaryDimensionFor(signalKey: string): Dimension | null {
  const entry = SIGNAL_MAP[signalKey];
  if (!entry) return null;
  const totals: Partial<Record<Dimension, number>> = {};
  for (const choice of Object.keys(entry)) {
    for (const dd of entry[choice]) {
      totals[dd.dim] = (totals[dd.dim] ?? 0) + Math.abs(dd.delta);
    }
  }
  let best: Dimension | null = null;
  let bestVal = -Infinity;
  for (const d of ALL_DIMENSIONS) {
    const v = totals[d] ?? 0;
    if (v > bestVal) {
      bestVal = v;
      best = d;
    }
  }
  return bestVal > 0 ? best : null;
}

/**
 * Given a signal_key, return a one-line plain-English annotation when
 * the user's declared profile is in a strong band on the primary dim,
 * else null.
 */
export function getDeclaredAnnotation(signalKey: string): string | null {
  if (!signalKey || typeof signalKey !== 'string') return null;
  const dim = primaryDimensionFor(signalKey);
  if (!dim) return null;

  const profile = readProfile();
  const declared = profile?.declared?.[dim];
  if (typeof declared !== 'number') return null;

  if (declared >= STRONG_HIGH) return DIMENSION_PHRASING[dim].high;
  if (declared <= STRONG_LOW) return DIMENSION_PHRASING[dim].low;
  return null;
}
