import { describe, expect, it } from 'vitest';
import { computePropIQScore, confidenceBand, scorePillar } from '@/domain/scoring/engine';
import { SCORE_PILLARS } from '@/domain/scoring/types';
import type { Signal } from '@/domain/scoring/types';
import { CURRENT_SCORING_VERSION, SCORING_VERSIONS, weightsSum } from '@/domain/scoring/weights';
import { BUYER_PERSONAS } from '@/domain/buyer/types';
import { valueProperty } from '@/domain/valuation/engine';
import { assessRisk } from '@/domain/risk/engine';
import {
  NOW,
  testDeveloper,
  testEvidence,
  testLocality,
  testProject,
  testProperty,
} from './support/factories';

const signal = (overrides: Partial<Signal> = {}): Signal => ({
  key: 's',
  label: 'Signal',
  raw: 1,
  normalized: 0.5,
  weight: 1,
  confidence: 0.8,
  evidenceFields: [],
  methodology: 'test',
  ...overrides,
});

describe('scoring version integrity', () => {
  it('has weights summing to 1 for every persona in every version', () => {
    for (const version of SCORING_VERSIONS) {
      for (const persona of BUYER_PERSONAS) {
        expect(weightsSum(version.weights[persona])).toBeCloseTo(1, 6);
      }
    }
  });

  it('assigns a weight to every declared pillar', () => {
    for (const persona of BUYER_PERSONAS) {
      const weights = CURRENT_SCORING_VERSION.weights[persona];
      for (const pillar of SCORE_PILLARS) {
        expect(weights[pillar]).toBeGreaterThan(0);
      }
    }
  });
});

describe('scorePillar', () => {
  it('returns undefined rather than zero when no signal has data', () => {
    const p = scorePillar('value', [signal({ normalized: undefined })]);
    expect(p.score).toBeUndefined();
    expect(p.coverage).toBe(0);
  });

  it('renormalizes weights over the signals that do have data', () => {
    // Two signals, equal weight; one missing. The result must be the surviving
    // signal's score, not the average of it and a phantom zero.
    const p = scorePillar('value', [
      signal({ key: 'a', normalized: 0.8, weight: 1 }),
      signal({ key: 'b', normalized: undefined, weight: 1 }),
    ]);
    expect(p.score).toBe(80);
    expect(p.coverage).toBe(0.5);
  });

  it('reports full coverage when every signal has data', () => {
    const p = scorePillar('value', [
      signal({ key: 'a', normalized: 1, weight: 3 }),
      signal({ key: 'b', normalized: 0, weight: 1 }),
    ]);
    expect(p.score).toBe(75);
    expect(p.coverage).toBe(1);
  });
});

describe('computePropIQScore', () => {
  const richInput = () => {
    const property = testProperty();
    const locality = testLocality();
    const valuation = valueProperty({
      property,
      marketDriftPercentPerYear: 7,
      now: NOW,
      comparables: [
        {
          label: 'A',
          soldOrListedAt: '2026-04-01T00:00:00Z',
          isTransaction: true,
          carpetAreaSqFt: 1100,
          pricePerSqFt: 13_800,
          distanceKm: 0.6,
          dataStatus: 'verified',
        },
        {
          label: 'B',
          soldOrListedAt: '2026-03-15T00:00:00Z',
          isTransaction: true,
          carpetAreaSqFt: 1150,
          pricePerSqFt: 14_100,
          distanceKm: 1.1,
          dataStatus: 'verified',
        },
        {
          label: 'C',
          soldOrListedAt: '2026-02-01T00:00:00Z',
          isTransaction: false,
          carpetAreaSqFt: 1080,
          pricePerSqFt: 14_600,
          distanceKm: 1.8,
          dataStatus: 'verified',
        },
      ],
    });
    const project = testProject();
    const developer = testDeveloper();
    const risk = assessRisk({ property, project, developer, locality, valuation, now: NOW });
    return { property, project, developer, locality, valuation, risk, now: NOW };
  };

  it('produces a score in range with a band and full pillar list', () => {
    const score = computePropIQScore(richInput());
    expect(score.score).toBeDefined();
    expect(score.score as number).toBeGreaterThan(0);
    expect(score.score as number).toBeLessThanOrEqual(100);
    expect(score.pillars).toHaveLength(SCORE_PILLARS.length);
    expect(score.band).toBeDefined();
    expect(score.band!.low).toBeLessThanOrEqual(score.score as number);
    expect(score.band!.high).toBeGreaterThanOrEqual(score.score as number);
  });

  it('records the scoring version it was computed under', () => {
    expect(computePropIQScore(richInput()).scoringVersion).toBe(CURRENT_SCORING_VERSION.version);
  });

  it('withholds a score when evidence falls below the reporting floor', () => {
    // A bare property with no project, locality, valuation or risk context.
    const score = computePropIQScore({ property: testProperty({ evidence: [] }), now: NOW });
    expect(score.score).toBeUndefined();
    expect(score.notes.join(' ')).toContain('reporting floor');
  });

  it('flags demo data so the UI can label the score', () => {
    const input = richInput();
    const score = computePropIQScore({
      ...input,
      property: testProperty({
        dataStatus: 'demo',
        evidence: [testEvidence({ dataStatus: 'demo' })],
      }),
    });
    expect(score.usesDemoData).toBe(true);
    expect(score.notes.join(' ')).toContain('fixture');
  });

  it('weights the same property differently for different personas', () => {
    const input = richInput();
    const homebuyer = computePropIQScore(input, { persona: 'homebuyer' });
    const investor = computePropIQScore(input, { persona: 'investor' });
    expect(homebuyer.persona).toBe('homebuyer');
    expect(investor.persona).toBe('investor');
    expect(homebuyer.score).not.toBe(investor.score);
  });

  it('names the pillars it could not score', () => {
    const score = computePropIQScore({
      property: testProperty(),
      locality: testLocality(),
      now: NOW,
    });
    const missing = score.pillars.filter((p) => p.score === undefined).map((p) => p.pillar);
    expect(missing).toContain('buyerFit'); // no buyer profile supplied
    expect(score.notes.join(' ')).toContain('No evidence for');
  });

  it('never returns a score outside 0..100', () => {
    const input = richInput();
    for (const persona of BUYER_PERSONAS) {
      const s = computePropIQScore(input, { persona });
      if (s.score !== undefined) {
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('is deterministic — the same input yields the identical score', () => {
    const input = richInput();
    expect(computePropIQScore(input).score).toBe(computePropIQScore(input).score);
  });
});

describe('confidenceBand', () => {
  it('widens as confidence and coverage fall', () => {
    const tight = confidenceBand(70, 1, 1);
    const loose = confidenceBand(70, 0.3, 0.3);
    expect(tight.high - tight.low).toBeLessThan(loose.high - loose.low);
  });

  it('clamps to the 0..100 scale', () => {
    expect(confidenceBand(2, 0.1, 0.1).low).toBe(0);
    expect(confidenceBand(99, 0.1, 0.1).high).toBe(100);
  });
});
