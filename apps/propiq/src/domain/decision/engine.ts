/**
 * The decision engine.
 *
 * Deterministic rules over score, risk and evidence confidence. No LLM is
 * involved in producing a verdict; the copilot may only *explain* one.
 *
 * The rule order is deliberate and is evaluated top-down:
 *   1. Evidence gate      — not enough to decide → INSUFFICIENT EVIDENCE
 *   2. Disqualifiers      — a single fatal risk → AVOID
 *   3. Price gate         — well above fair value → NEGOTIATE at best
 *   4. Score bands        — BUY / WATCH by composite
 *
 * Every verdict carries the decisive positives, decisive negatives, and the
 * unknowns, because a verdict a buyer cannot interrogate is not intelligence.
 */

import type { Instant, Unit01 } from '../shared/types';
import { clamp01, round } from '../shared/types';
import type { PropIQScore } from '../scoring/types';
import type { RiskAssessment } from '../risk/types';
import type { Valuation } from '../valuation/types';

export const DECISIONS = ['BUY', 'NEGOTIATE', 'WATCH', 'AVOID', 'INSUFFICIENT_EVIDENCE'] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_LABELS: Readonly<Record<Decision, string>> = {
  BUY: 'Buy',
  NEGOTIATE: 'Negotiate',
  WATCH: 'Watch',
  AVOID: 'Avoid',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

export const DECISION_DESCRIPTIONS: Readonly<Record<Decision, string>> = {
  BUY: 'The evidence supports buying at or near the asking price.',
  NEGOTIATE: 'Worth buying, but not at this price. Go in with a number.',
  WATCH: 'Not a no, but something needs to change before this is a buy.',
  AVOID: 'A material problem here outweighs what the property does well.',
  INSUFFICIENT_EVIDENCE:
    'We do not have enough verified evidence to give you a verdict on this property.',
};

export interface DecisionFactor {
  readonly label: string;
  readonly detail: string;
  /** Which rule produced this factor, for auditability. */
  readonly rule: string;
}

export interface DecisionResult {
  readonly decision: Decision;
  readonly decidedAt: Instant;
  readonly rulesVersion: string;
  /** How sure we are of the *verdict*, distinct from the score's own confidence. */
  readonly confidence: Unit01;
  readonly headline: string;
  readonly positives: readonly DecisionFactor[];
  readonly negatives: readonly DecisionFactor[];
  readonly unknowns: readonly DecisionFactor[];
  /** The rule that fired, named so support can reproduce any verdict. */
  readonly decidingRule: string;
}

export const DECISION_RULES_VERSION = '0.1.0';

export interface DecisionInput {
  readonly score: PropIQScore;
  readonly risk?: RiskAssessment;
  readonly valuation?: Valuation;
  readonly now: Instant;
}

/** Thresholds are published alongside the scoring methodology. */
export const DECISION_THRESHOLDS = {
  buyScore: 72,
  watchScore: 55,
  /** Above this deviation from fair value, a BUY is downgraded to NEGOTIATE. */
  negotiateDeviationPercent: 6,
  /** A single risk dimension at or above this severity is disqualifying. */
  fatalRiskSeverity: 0.75,
  /** Composite risk at or above this severity caps the verdict at WATCH. */
  heavyRiskSeverity: 0.55,
  minVerdictConfidence: 0.35,
} as const;

export const decide = (input: DecisionInput): DecisionResult => {
  const { score, risk, valuation, now } = input;
  const positives: DecisionFactor[] = [];
  const negatives: DecisionFactor[] = [];
  const unknowns: DecisionFactor[] = [];

  // --- Collect factors up front so every verdict is explained the same way ---

  for (const pillarScore of score.pillars) {
    if (pillarScore.score === undefined) {
      unknowns.push({
        label: pillarScore.label,
        detail: 'No evidence available for this pillar.',
        rule: 'pillar.noEvidence',
      });
    } else if (pillarScore.score >= 78) {
      positives.push({
        label: pillarScore.label,
        detail: `Scores ${pillarScore.score}/100.`,
        rule: 'pillar.strong',
      });
    } else if (pillarScore.score <= 45) {
      negatives.push({
        label: pillarScore.label,
        detail: `Scores ${pillarScore.score}/100.`,
        rule: 'pillar.weak',
      });
    }
  }

  if (risk) {
    for (const dimension of risk.materialRisks) {
      negatives.push({
        label: dimension.label,
        detail: dimension.drivers[0] ?? `Severity ${dimension.severity}.`,
        rule: `risk.${dimension.dimension}.material`,
      });
    }
    for (const dimension of risk.dimensions.filter((d) => !d.hasData)) {
      unknowns.push({
        label: dimension.label,
        detail: dimension.drivers[0] ?? 'No data for this risk dimension.',
        rule: `risk.${dimension.dimension}.noData`,
      });
    }
  } else {
    unknowns.push({
      label: 'Risk assessment',
      detail: 'No risk assessment was run for this property.',
      rule: 'risk.absent',
    });
  }

  if (valuation && !valuation.insufficientEvidence) {
    if (valuation.askingDeviationPercent <= -3) {
      positives.push({
        label: 'Priced below fair value',
        detail: `Asking is ${Math.abs(valuation.askingDeviationPercent)}% below our central estimate.`,
        rule: 'valuation.underpriced',
      });
    } else if (valuation.askingDeviationPercent >= DECISION_THRESHOLDS.negotiateDeviationPercent) {
      negatives.push({
        label: 'Priced above fair value',
        detail: `Asking is ${valuation.askingDeviationPercent}% above our central estimate.`,
        rule: 'valuation.overpriced',
      });
    }
  } else {
    unknowns.push({
      label: 'Fair value',
      detail: 'Not enough comparables to form a fair-value view.',
      rule: 'valuation.insufficient',
    });
  }

  const base = (
    decision: Decision,
    decidingRule: string,
    headline: string,
    confidence: number,
  ): DecisionResult => ({
    decision,
    decidedAt: now,
    rulesVersion: DECISION_RULES_VERSION,
    confidence: clamp01(round(confidence, 3)),
    headline,
    positives,
    negatives,
    unknowns,
    decidingRule,
  });

  // --- Rule 1: evidence gate -------------------------------------------------
  if (score.score === undefined) {
    return base(
      'INSUFFICIENT_EVIDENCE',
      'gate.noScore',
      'We do not have enough verified evidence about this property to give you a verdict.',
      0,
    );
  }

  // Verdict confidence blends score confidence with risk coverage: a confident
  // score on a property whose risks we never assessed is not a confident verdict.
  const verdictConfidence = clamp01(
    score.confidence * 0.6 + (risk?.coverage ?? 0) * 0.25 + (valuation?.confidence ?? 0) * 0.15,
  );

  if (verdictConfidence < DECISION_THRESHOLDS.minVerdictConfidence) {
    return base(
      'INSUFFICIENT_EVIDENCE',
      'gate.lowConfidence',
      'The evidence we have is too thin or too old to support a verdict.',
      verdictConfidence,
    );
  }

  // --- Rule 2: disqualifiers -------------------------------------------------
  const fatal = risk?.dimensions.find(
    (d) => d.hasData && d.severity >= DECISION_THRESHOLDS.fatalRiskSeverity,
  );
  if (fatal) {
    return base(
      'AVOID',
      `disqualifier.${fatal.dimension}`,
      `${fatal.label} is severe enough to outweigh everything this property does well.`,
      verdictConfidence,
    );
  }

  // --- Rule 3: price gate ----------------------------------------------------
  const overpriced =
    valuation &&
    !valuation.insufficientEvidence &&
    valuation.askingDeviationPercent >= DECISION_THRESHOLDS.negotiateDeviationPercent;

  const heavyRisk =
    risk !== undefined &&
    risk.coverage > 0 &&
    risk.compositeSeverity >= DECISION_THRESHOLDS.heavyRiskSeverity;

  if (heavyRisk && score.score < DECISION_THRESHOLDS.buyScore) {
    return base(
      'WATCH',
      'risk.heavyComposite',
      'The fundamentals are reasonable, but the risk profile needs to improve before this is a buy.',
      verdictConfidence,
    );
  }

  // --- Rule 4: score bands ---------------------------------------------------
  if (score.score >= DECISION_THRESHOLDS.buyScore) {
    if (overpriced) {
      return base(
        'NEGOTIATE',
        'price.aboveFairValue',
        `A good property at the wrong price. Our estimate says there is ${valuation?.askingDeviationPercent}% to argue about.`,
        verdictConfidence,
      );
    }
    return base(
      'BUY',
      'score.buyBand',
      'The evidence supports buying this at or near the asking price.',
      verdictConfidence,
    );
  }

  if (score.score >= DECISION_THRESHOLDS.watchScore) {
    if (overpriced) {
      return base(
        'NEGOTIATE',
        'price.aboveFairValue',
        'Only worth it at a lower number. Go in with our target price, not the asking price.',
        verdictConfidence,
      );
    }
    return base(
      'WATCH',
      'score.watchBand',
      'Not a no. Something specific needs to change before this becomes a buy.',
      verdictConfidence,
    );
  }

  return base(
    'AVOID',
    'score.avoidBand',
    'Too many weak fundamentals here to recommend it against the alternatives.',
    verdictConfidence,
  );
};
