/**
 * Versioned pillar weights.
 *
 * Weights are part of the published methodology, so changing them is a public
 * API change: add a new version, never mutate an existing one. Stored scores
 * reference the version they were computed under.
 */

import type { BuyerPersona } from '../buyer/types';
import type { ScorePillar } from './types';

export type PillarWeights = Readonly<Record<ScorePillar, number>>;

export interface ScoringVersion {
  readonly version: string;
  readonly effectiveFrom: string;
  readonly summary: string;
  readonly weights: Readonly<Record<BuyerPersona, PillarWeights>>;
  /** Composite coverage below this floor yields INSUFFICIENT EVIDENCE, not a number. */
  readonly minimumCoverage: number;
  /** Composite confidence below this floor yields INSUFFICIENT EVIDENCE. */
  readonly minimumConfidence: number;
}

const HOMEBUYER: PillarWeights = {
  value: 0.15,
  legal: 0.13,
  developer: 0.1,
  project: 0.08,
  unit: 0.1,
  location: 0.11,
  infrastructure: 0.06,
  livability: 0.08,
  investment: 0.04,
  liquidity: 0.03,
  risk: 0.07,
  buyerFit: 0.05,
};

const INVESTOR: PillarWeights = {
  value: 0.16,
  legal: 0.12,
  developer: 0.09,
  project: 0.05,
  unit: 0.05,
  location: 0.1,
  infrastructure: 0.08,
  livability: 0.03,
  investment: 0.16,
  liquidity: 0.09,
  risk: 0.05,
  buyerFit: 0.02,
};

const NRI: PillarWeights = {
  value: 0.13,
  legal: 0.18,
  developer: 0.14,
  project: 0.07,
  unit: 0.06,
  location: 0.1,
  infrastructure: 0.06,
  livability: 0.04,
  investment: 0.09,
  liquidity: 0.06,
  risk: 0.05,
  buyerFit: 0.02,
};

export const SCORING_V0_1: ScoringVersion = {
  version: '0.1.0',
  effectiveFrom: '2026-01-01',
  summary:
    'First published PropIQ Score. Twelve pillars, persona-weighted, with missing-data ' +
    'renormalization and an evidence-confidence band. No model-generated scores anywhere ' +
    'in the pipeline.',
  weights: { homebuyer: HOMEBUYER, investor: INVESTOR, nri: NRI },
  minimumCoverage: 0.45,
  minimumConfidence: 0.35,
};

export const CURRENT_SCORING_VERSION = SCORING_V0_1;

export const SCORING_VERSIONS: readonly ScoringVersion[] = [SCORING_V0_1];

export const getScoringVersion = (version: string): ScoringVersion | undefined =>
  SCORING_VERSIONS.find((v) => v.version === version);

/** Guards the invariant that every persona's weights sum to 1. Exercised by tests. */
export const weightsSum = (weights: PillarWeights): number =>
  Object.values(weights).reduce((a, b) => a + b, 0);
