/**
 * The PropIQ Score aggregator.
 *
 * Pipeline: signals → pillar scores → persona-weighted composite.
 *
 * Two behaviours matter more than the arithmetic:
 *  1. Missing-data renormalization. Signals without data are dropped and the
 *     remaining weights rescaled, so an absent field never reads as a zero.
 *     The share of weight that survived is reported as `coverage`.
 *  2. The reporting floor. Below the version's minimum coverage or confidence
 *     we return `score: undefined`, which the decision engine turns into
 *     INSUFFICIENT EVIDENCE. A thin record produces no number at all.
 */

import type { Unit01 } from '../shared/types';
import { clamp01, round } from '../shared/types';
import type { BuyerPersona } from '../buyer/types';
import { containsDemoData } from '../evidence/types';
import { toScore100 } from './normalize';
import type { ScoringInput } from './signals';
import {
  buyerFitSignals,
  developerSignals,
  infrastructureSignals,
  investmentSignals,
  legalSignals,
  liquiditySignals,
  livabilitySignals,
  locationSignals,
  projectSignals,
  riskSignals,
  staleEvidenceCount,
  unitSignals,
  valueSignals,
} from './signals';
import type { PillarScore, PropIQScore, ScorePillar, Signal } from './types';
import { PILLAR_LABELS } from './types';
import type { ScoringVersion } from './weights';
import { CURRENT_SCORING_VERSION } from './weights';

const BUILDERS: Readonly<Record<ScorePillar, (input: ScoringInput) => Signal[]>> = {
  value: valueSignals,
  legal: legalSignals,
  developer: developerSignals,
  project: projectSignals,
  unit: unitSignals,
  location: locationSignals,
  infrastructure: infrastructureSignals,
  livability: livabilitySignals,
  investment: investmentSignals,
  liquidity: liquiditySignals,
  risk: riskSignals,
  buyerFit: buyerFitSignals,
};

/**
 * Collapse a pillar's signals into a score.
 * Weights are renormalized over signals that actually have a value.
 */
export const scorePillar = (key: ScorePillar, signals: readonly Signal[]): PillarScore => {
  const totalWeight = signals.reduce((a, s) => a + s.weight, 0);
  const usable = signals.filter((s) => s.normalized !== undefined);
  const usableWeight = usable.reduce((a, s) => a + s.weight, 0);

  if (usableWeight <= 0 || totalWeight <= 0) {
    return {
      pillar: key,
      label: PILLAR_LABELS[key],
      score: undefined,
      coverage: 0,
      confidence: 0,
      signals,
    };
  }

  const weightedUnit =
    usable.reduce((a, s) => a + (s.normalized ?? 0) * s.weight, 0) / usableWeight;
  const confidence = usable.reduce((a, s) => a + s.confidence * s.weight, 0) / usableWeight;

  return {
    pillar: key,
    label: PILLAR_LABELS[key],
    score: toScore100(weightedUnit),
    coverage: round(usableWeight / totalWeight, 3),
    confidence: clamp01(round(confidence, 3)),
    signals,
  };
};

export interface ScoreOptions {
  readonly persona?: BuyerPersona;
  readonly version?: ScoringVersion;
}

export const computePropIQScore = (
  input: ScoringInput,
  options: ScoreOptions = {},
): PropIQScore => {
  const version = options.version ?? CURRENT_SCORING_VERSION;
  const persona: BuyerPersona = options.persona ?? input.buyer?.persona ?? 'homebuyer';
  const personaWeights = version.weights[persona];

  const pillars = (Object.keys(BUILDERS) as ScorePillar[]).map((key) =>
    scorePillar(key, BUILDERS[key](input)),
  );

  // Renormalize pillar weights the same way: a pillar with no data drops out.
  const scored = pillars.filter((p) => p.score !== undefined);
  const declaredWeight = pillars.reduce((a, p) => a + personaWeights[p.pillar], 0);
  const liveWeight = scored.reduce((a, p) => a + personaWeights[p.pillar], 0);

  const notes: string[] = [];
  const usesDemoData =
    input.property.dataStatus === 'demo' ||
    containsDemoData(input.property.evidence) ||
    input.locality?.dataStatus === 'demo';

  if (liveWeight <= 0) {
    return {
      scoringVersion: version.version,
      computedAt: input.now,
      persona,
      score: undefined,
      confidence: 0,
      coverage: 0,
      pillars,
      weights: personaWeights,
      usesDemoData,
      notes: ['No pillar had enough evidence to score.'],
    };
  }

  const composite =
    scored.reduce((a, p) => a + (p.score ?? 0) * personaWeights[p.pillar], 0) / liveWeight;

  // Coverage blends "which pillars scored at all" with "how complete each was",
  // so a record that scores every pillar on one signal each still reads as thin.
  const coverage = round(
    scored.reduce((a, p) => a + personaWeights[p.pillar] * p.coverage, 0) / declaredWeight,
    3,
  );
  const confidence = clamp01(
    round(scored.reduce((a, p) => a + personaWeights[p.pillar] * p.confidence, 0) / liveWeight, 3),
  );

  const missing = pillars.filter((p) => p.score === undefined);
  if (missing.length > 0) {
    notes.push(
      `No evidence for: ${missing.map((p) => p.label).join(', ')}. ` +
        'These pillars were excluded and the remaining weights rescaled.',
    );
  }
  const stale = staleEvidenceCount(input);
  if (stale > 0) notes.push(`${stale} evidence record(s) are past their freshness window.`);
  if (usesDemoData) {
    notes.push('This score includes development fixture data and is not a live market reading.');
  }

  const belowFloor = coverage < version.minimumCoverage || confidence < version.minimumConfidence;
  if (belowFloor) {
    notes.push(
      `Coverage ${Math.round(coverage * 100)}% / confidence ${Math.round(confidence * 100)}% is ` +
        `below the v${version.version} reporting floor ` +
        `(${Math.round(version.minimumCoverage * 100)}% / ${Math.round(version.minimumConfidence * 100)}%). ` +
        'PropIQ does not publish a score at this evidence level.',
    );
  }

  return {
    scoringVersion: version.version,
    computedAt: input.now,
    persona,
    score: belowFloor ? undefined : round(composite, 1),
    band: belowFloor ? undefined : confidenceBand(composite, confidence, coverage),
    confidence,
    coverage,
    pillars,
    weights: personaWeights,
    usesDemoData,
    notes,
  };
};

/**
 * A 95% band on the composite.
 *
 * This expresses uncertainty in the *evidence*, not sampling noise: the less
 * complete and less confident the inputs, the wider the band. Half-width runs
 * from 2 points at full confidence and coverage to 18 points at the floor.
 */
export const confidenceBand = (
  score: number,
  confidence: Unit01,
  coverage: Unit01,
): { low: number; high: number } => {
  const uncertainty = 1 - clamp01(confidence * 0.6 + coverage * 0.4);
  const halfWidth = 2 + uncertainty * 16;
  return {
    low: round(Math.max(0, score - halfWidth), 1),
    high: round(Math.min(100, score + halfWidth), 1),
  };
};
