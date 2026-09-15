import { describe, expect, it } from 'vitest';
import { DECISION_THRESHOLDS, decide } from '@/domain/decision/engine';
import type { PropIQScore } from '@/domain/scoring/types';
import type { RiskAssessment, RiskSignalDetail } from '@/domain/risk/types';
import type { Valuation } from '@/domain/valuation/types';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { NOW } from './support/factories';

const score = (overrides: Partial<PropIQScore> = {}): PropIQScore => ({
  scoringVersion: '0.1.0',
  computedAt: NOW,
  persona: 'homebuyer',
  score: 80,
  confidence: 0.8,
  coverage: 0.8,
  pillars: [],
  weights: {},
  usesDemoData: false,
  notes: [],
  ...overrides,
});

const riskDetail = (overrides: Partial<RiskSignalDetail> = {}): RiskSignalDetail => ({
  dimension: 'legal',
  label: 'Legal & title risk',
  severity: 0.1,
  band: 'low',
  weight: 0.2,
  confidence: 0.8,
  drivers: ['Clean.'],
  evidenceFields: [],
  methodology: 'test',
  hasData: true,
  ...overrides,
});

const risk = (overrides: Partial<RiskAssessment> = {}): RiskAssessment => ({
  computedAt: NOW,
  methodologyVersion: '0.1.0',
  dimensions: [riskDetail()],
  compositeSeverity: 0.1,
  compositeBand: 'low',
  coverage: 0.9,
  materialRisks: [],
  ...overrides,
});

const valuation = (overrides: Partial<Valuation> = {}): Valuation => ({
  propertyId: asId<PropertyId>('prop-1'),
  computedAt: NOW,
  methodologyVersion: '0.1.0',
  low: 9_000_000,
  mid: 10_000_000,
  high: 11_000_000,
  perSqFtMid: 9_000,
  askingPrice: 10_000_000,
  askingDeviationPercent: 0,
  confidence: 0.7,
  comparables: [],
  adjustmentNotes: [],
  dataStatus: 'estimated',
  freshnessDays: 20,
  insufficientEvidence: false,
  ...overrides,
});

describe('decide', () => {
  it('returns INSUFFICIENT_EVIDENCE when no score could be computed', () => {
    const d = decide({ score: score({ score: undefined }), risk: risk(), now: NOW });
    expect(d.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(d.decidingRule).toBe('gate.noScore');
    expect(d.confidence).toBe(0);
  });

  it('returns INSUFFICIENT_EVIDENCE when verdict confidence is below the floor', () => {
    const d = decide({
      score: score({ score: 85, confidence: 0.2 }),
      risk: risk({ coverage: 0.1 }),
      valuation: valuation({ confidence: 0.1 }),
      now: NOW,
    });
    expect(d.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(d.decidingRule).toBe('gate.lowConfidence');
  });

  it('returns BUY for a strong score, fair price and low risk', () => {
    const d = decide({
      score: score({ score: 82 }),
      risk: risk(),
      valuation: valuation(),
      now: NOW,
    });
    expect(d.decision).toBe('BUY');
    expect(d.decidingRule).toBe('score.buyBand');
  });

  it('downgrades a strong property to NEGOTIATE when it is priced above fair value', () => {
    const d = decide({
      score: score({ score: 82 }),
      risk: risk(),
      valuation: valuation({ askingDeviationPercent: 14 }),
      now: NOW,
    });
    expect(d.decision).toBe('NEGOTIATE');
    expect(d.decidingRule).toBe('price.aboveFairValue');
    expect(d.negatives.some((n) => n.rule === 'valuation.overpriced')).toBe(true);
  });

  it('returns AVOID when a single risk dimension is disqualifying, whatever the score', () => {
    const d = decide({
      score: score({ score: 95 }),
      risk: risk({
        dimensions: [riskDetail({ dimension: 'legal', severity: 0.9, band: 'high' })],
        materialRisks: [riskDetail({ dimension: 'legal', severity: 0.9, band: 'high' })],
      }),
      valuation: valuation(),
      now: NOW,
    });
    expect(d.decision).toBe('AVOID');
    expect(d.decidingRule).toBe('disqualifier.legal');
  });

  it('caps a mid-band property at WATCH when composite risk is heavy', () => {
    const d = decide({
      score: score({ score: 68 }),
      risk: risk({ compositeSeverity: 0.6, compositeBand: 'elevated' }),
      valuation: valuation(),
      now: NOW,
    });
    expect(d.decision).toBe('WATCH');
    expect(d.decidingRule).toBe('risk.heavyComposite');
  });

  it('returns WATCH in the mid score band', () => {
    const d = decide({
      score: score({ score: 60 }),
      risk: risk(),
      valuation: valuation(),
      now: NOW,
    });
    expect(d.decision).toBe('WATCH');
    expect(d.decidingRule).toBe('score.watchBand');
  });

  it('returns AVOID below the watch band', () => {
    const d = decide({
      score: score({ score: 40 }),
      risk: risk(),
      valuation: valuation(),
      now: NOW,
    });
    expect(d.decision).toBe('AVOID');
    expect(d.decidingRule).toBe('score.avoidBand');
  });

  it('lists unknowns when the valuation has insufficient evidence', () => {
    const d = decide({
      score: score(),
      risk: risk(),
      valuation: valuation({ insufficientEvidence: true }),
      now: NOW,
    });
    expect(d.unknowns.some((u) => u.rule === 'valuation.insufficient')).toBe(true);
  });

  it('credits a below-fair-value asking price as a positive', () => {
    const d = decide({
      score: score(),
      risk: risk(),
      valuation: valuation({ askingDeviationPercent: -8 }),
      now: NOW,
    });
    expect(d.positives.some((p) => p.rule === 'valuation.underpriced')).toBe(true);
  });

  it('records the rules version so any verdict can be reproduced', () => {
    expect(decide({ score: score(), risk: risk(), now: NOW }).rulesVersion).toBe('0.1.0');
  });

  it('honours the published buy threshold exactly at the boundary', () => {
    const at = decide({
      score: score({ score: DECISION_THRESHOLDS.buyScore }),
      risk: risk(),
      valuation: valuation(),
      now: NOW,
    });
    const below = decide({
      score: score({ score: DECISION_THRESHOLDS.buyScore - 0.1 }),
      risk: risk(),
      valuation: valuation(),
      now: NOW,
    });
    expect(at.decision).toBe('BUY');
    expect(below.decision).toBe('WATCH');
  });
});
