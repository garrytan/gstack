/**
 * The verdict palette, in one place.
 *
 * Four copies of this map had drifted across the badge, the rail, the map and
 * the dial, and two more places derived a *fifth* colour by re-deriving the
 * verdict from the score alone — which the engine does not do. `decideProperty`
 * reaches its call from the score, the risk severity and the price gap
 * together, so a score-only threshold can disagree with the badge printed
 * beside it. One map, fed the real decision, removes both problems.
 *
 * A plain module, not a component file: a constant exported from a
 * `'use client'` module becomes a client reference when a server component
 * imports it, and renders as React's error text rather than a value.
 */

import type { Decision } from '@/domain/decision/engine';

export const DECISION_COLOUR: Readonly<Record<Decision, string>> = {
  BUY: 'var(--color-buy)',
  NEGOTIATE: 'var(--color-negotiate)',
  WATCH: 'var(--color-watch)',
  AVOID: 'var(--color-avoid)',
  INSUFFICIENT_EVIDENCE: 'var(--color-unknown)',
};
