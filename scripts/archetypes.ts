/**
 * Archetypes — one-word builder identities computed from dimension clusters.
 *
 * Used by future /plan-tune vibe and /plan-tune narrative commands (v2).
 * v1 ships the definitions but doesn't wire them into user-facing output
 * yet. This file exists so the archetype model is stable by the time v2
 * narrative generation ships.
 *
 * Design
 * ------
 * Each archetype is a point or region in the 5-dimensional psychographic
 * space. `distance()` computes L2 distance from a profile to the archetype
 * center, scaled by the archetype's "tightness" (how close you have to be
 * to match). The archetype with smallest distance is the user's match.
 *
 * When no archetype is within threshold, return 'Polymath' — a calibrated
 * "doesn't fit the common patterns" label that's respectful rather than
 * generic.
 */

import type { Dimension } from './psychographic-signals';

export interface Archetype {
  /** Short vibe label — one or two words. */
  name: string;
  /** One-line description anchored in observable behavior. */
  description: string;
  /** Center point in the 5-dimensional space. */
  center: Record<Dimension, number>;
  /** Inverse-weighted radius. Smaller = tighter match needed. */
  tightness: number;
}

export const ARCHETYPES: readonly Archetype[] = [
  {
    name: 'Cathedral Builder',
    description: 'Boil the ocean. Architecture first. Ship the complete thing.',
    center: {
      scope_appetite: 0.85,
      risk_tolerance: 0.55,
      detail_preference: 0.5,
      autonomy: 0.5,
      architecture_care: 0.85,
    },
    tightness: 1.0,
  },
  {
    name: 'Ship-It Pragmatist',
    description: 'Small scope, fast iteration. Good enough is done.',
    center: {
      scope_appetite: 0.25,
      risk_tolerance: 0.75,
      detail_preference: 0.3,
      autonomy: 0.65,
      architecture_care: 0.4,
    },
    tightness: 1.0,
  },
  {
    name: 'Deep Craft',
    description: 'Every detail matters. Verbose explanations. Slow and considered.',
    center: {
      scope_appetite: 0.6,
      risk_tolerance: 0.35,
      detail_preference: 0.85,
      autonomy: 0.35,
      architecture_care: 0.85,
    },
    tightness: 1.0,
  },
  {
    name: 'Taste Maker',
    description: 'Decisions feel intuitive. Overrides recommendations when taste dictates.',
    center: {
      scope_appetite: 0.6,
      risk_tolerance: 0.6,
      detail_preference: 0.5,
      autonomy: 0.4,
      architecture_care: 0.7,
    },
    tightness: 0.9,
  },
  {
    name: 'Solo Operator',
    description: 'High autonomy. Delegate to the agent. Trust but verify.',
    center: {
      scope_appetite: 0.5,
      risk_tolerance: 0.7,
      detail_preference: 0.3,
      autonomy: 0.85,
      architecture_care: 0.55,
    },
    tightness: 0.9,
  },
  {
    name: 'Consultant',
    description: 'Hands-on. Wants to be consulted on everything. Verifies each step.',
    center: {
      scope_appetite: 0.5,
      risk_tolerance: 0.3,
      detail_preference: 0.7,
      autonomy: 0.2,
      architecture_care: 0.65,
    },
    tightness: 0.9,
  },
  {
    name: 'Wedge Hunter',
    description: 'Narrow scope aggressively. Find the smallest thing worth building.',
    center: {
      scope_appetite: 0.15,
      risk_tolerance: 0.5,
      detail_preference: 0.4,
      autonomy: 0.55,
      architecture_care: 0.6,
    },
    tightness: 0.85,
  },
  {
    name: 'Builder-Coach',
    description: 'Balanced steering. Makes room for the agent to propose and challenge.',
    center: {
      scope_appetite: 0.55,
      risk_tolerance: 0.5,
      detail_preference: 0.55,
      autonomy: 0.55,
      architecture_care: 0.6,
    },
    tightness: 0.75,
  },
];

/**
 * Fallback used when no archetype is close enough — meaning the user's
 * dimension cluster genuinely doesn't match any named pattern.
 */
export const FALLBACK_ARCHETYPE: Archetype = {
  name: 'Polymath',
  description: "Your steering style doesn't fit a common archetype. That's a compliment.",
  center: { scope_appetite: 0.5, risk_tolerance: 0.5, detail_preference: 0.5, autonomy: 0.5, architecture_care: 0.5 },
  tightness: 0,
};

const DIMENSIONS: readonly Dimension[] = [
  'scope_appetite',
  'risk_tolerance',
  'detail_preference',
  'autonomy',
  'architecture_care',
] as const;

function euclidean(a: Record<Dimension, number>, b: Record<Dimension, number>): number {
  let sumSq = 0;
  for (const d of DIMENSIONS) {
    const diff = (a[d] ?? 0.5) - (b[d] ?? 0.5);
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq);
}

/**
 * Match a profile to its best archetype.
 * Returns FALLBACK_ARCHETYPE if no defined archetype is within threshold.
 */
export function matchArchetype(dims: Record<Dimension, number>): Archetype {
  let best: Archetype = FALLBACK_ARCHETYPE;
  let bestScore = Infinity; // lower is better
  // Threshold: if no archetype scores below this, return Polymath.
  // Max possible distance in [0,1]^5 is sqrt(5) ≈ 2.236. 0.55 = ~half the space.
  const THRESHOLD = 0.55;
  for (const arch of ARCHETYPES) {
    const dist = euclidean(dims, arch.center);
    // Scale by tightness — tighter archetypes require smaller actual distance.
    const scaled = dist / (arch.tightness || 1);
    if (scaled < bestScore && scaled <= THRESHOLD) {
      bestScore = scaled;
      best = arch;
    }
  }
  return best;
}

/** All archetype names, useful for tests and /plan-tune stats. */
export function getAllArchetypeNames(): string[] {
  return ARCHETYPES.map((a) => a.name).concat(FALLBACK_ARCHETYPE.name);
}
