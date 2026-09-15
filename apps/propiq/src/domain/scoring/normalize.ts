/**
 * Normalization primitives.
 *
 * Scoring never lets an LLM pick a number. Raw indicators are mapped to 0..1
 * by explicit, published, testable functions. Each function below states the
 * direction of goodness so a reviewer can check the mapping by reading it.
 */

import type { Unit01 } from '../shared/types';
import { clamp01, round } from '../shared/types';

/** Higher raw value is better. Below `min` scores 0, above `max` scores 1. */
export const higherIsBetter = (value: number, min: number, max: number): Unit01 => {
  if (max === min) return 0.5;
  return clamp01((value - min) / (max - min));
};

/** Lower raw value is better. At or below `best` scores 1, at or above `worst` scores 0. */
export const lowerIsBetter = (value: number, best: number, worst: number): Unit01 => {
  if (worst === best) return 0.5;
  return clamp01((worst - value) / (worst - best));
};

/**
 * Goodness peaks at `ideal` and falls off linearly to 0 at `ideal ± tolerance`.
 * Used where both extremes are bad — e.g. floor level, or a price so far below
 * market that it signals a problem rather than a bargain.
 */
export const bandedIdeal = (value: number, ideal: number, tolerance: number): Unit01 => {
  if (tolerance <= 0) return value === ideal ? 1 : 0;
  return clamp01(1 - Math.abs(value - ideal) / tolerance);
};

/**
 * Logistic mapping for indicators with diminishing returns at both ends
 * (e.g. developer delivery track record). `midpoint` scores 0.5; `steepness`
 * controls how fast the curve moves around it.
 */
export const logistic = (value: number, midpoint: number, steepness: number): Unit01 =>
  clamp01(1 / (1 + Math.exp(-steepness * (value - midpoint))));

/** Map a discrete label to a score via an explicit table. Unknown labels score `fallback`. */
export const fromTable = <K extends string>(
  value: K | undefined,
  table: Readonly<Record<K, number>>,
  fallback = 0.5,
): Unit01 => (value !== undefined && value in table ? clamp01(table[value]) : clamp01(fallback));

/** Convert a 0..1 unit score to the 0..100 scale used in the product surface. */
export const toScore100 = (unit: Unit01): number => round(clamp01(unit) * 100, 1);
