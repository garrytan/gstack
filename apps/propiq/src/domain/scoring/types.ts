/**
 * PropIQ Score types.
 *
 * The published contract is: structured evidence → normalized signals →
 * pillar scores → weighted composite. Every layer is retained in the output so
 * the UI can expand a score into the numbers that produced it, and so a score
 * computed six months ago can be re-explained without re-running anything.
 */

import type { Instant, Unit01 } from '../shared/types';
import type { BuyerPersona } from '../buyer/types';

export const SCORE_PILLARS = [
  'value',
  'legal',
  'developer',
  'project',
  'unit',
  'location',
  'infrastructure',
  'livability',
  'investment',
  'liquidity',
  'risk',
  'buyerFit',
] as const;
export type ScorePillar = (typeof SCORE_PILLARS)[number];

export const PILLAR_LABELS: Readonly<Record<ScorePillar, string>> = {
  value: 'Value for money',
  legal: 'Legal confidence',
  developer: 'Developer track record',
  project: 'Project quality',
  unit: 'Unit & design',
  location: 'Location',
  infrastructure: 'Infrastructure',
  livability: 'Livability',
  investment: 'Investment outlook',
  liquidity: 'Liquidity',
  risk: 'Risk profile',
  buyerFit: 'Fit for you',
};

/** One measured input to a pillar. `normalized` is undefined when we lack data. */
export interface Signal {
  readonly key: string;
  readonly label: string;
  /** The raw observed value, kept so the UI can show "18 months" not just "0.62". */
  readonly raw: number | string | undefined;
  readonly unit?: string;
  readonly normalized: Unit01 | undefined;
  /** Weight of this signal inside its pillar, before missing-data renormalization. */
  readonly weight: number;
  /** Confidence in the underlying evidence, 0..1. */
  readonly confidence: Unit01;
  /** Evidence field paths backing this signal. */
  readonly evidenceFields: readonly string[];
  readonly methodology: string;
}

export interface PillarScore {
  readonly pillar: ScorePillar;
  readonly label: string;
  /** 0..100, or undefined when no signal in this pillar had data. */
  readonly score: number | undefined;
  /** Share of pillar weight that had usable data, 0..1. */
  readonly coverage: Unit01;
  readonly confidence: Unit01;
  readonly signals: readonly Signal[];
}

export interface PropIQScore {
  readonly scoringVersion: string;
  readonly computedAt: Instant;
  readonly persona: BuyerPersona;
  /** 0..100 composite, or undefined when coverage is below the reporting floor. */
  readonly score: number | undefined;
  /** 95% band on the composite, reflecting evidence confidence, not model noise. */
  readonly band?: { readonly low: number; readonly high: number };
  readonly confidence: Unit01;
  readonly coverage: Unit01;
  readonly pillars: readonly PillarScore[];
  readonly weights: Readonly<Partial<Record<ScorePillar, number>>>;
  /** True when any input was demo data — the UI must label the score accordingly. */
  readonly usesDemoData: boolean;
  readonly notes: readonly string[];
}

export const pillar = (score: PropIQScore, key: ScorePillar): PillarScore | undefined =>
  score.pillars.find((p) => p.pillar === key);
