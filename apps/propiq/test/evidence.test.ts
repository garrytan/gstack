import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  effectiveConfidence,
  evidenceAgeDays,
  isStale,
  summarizeFreshness,
} from '@/domain/evidence/freshness';
import { containsDemoData, isRealData } from '@/domain/evidence/types';
import { NOW, testEvidence, testSource } from './support/factories';

describe('daysBetween', () => {
  it('measures elapsed days', () => {
    expect(daysBetween('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')).toBe(30);
  });

  it('returns Infinity for an unparseable instant rather than NaN', () => {
    expect(daysBetween('not-a-date', NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('evidenceAgeDays', () => {
  it('measures from the last verification when one exists', () => {
    const ev = testEvidence({
      observedAt: '2025-01-01T00:00:00Z',
      lastVerifiedAt: '2026-05-01T00:00:00Z',
    });
    expect(evidenceAgeDays(ev, NOW)).toBe(31);
  });

  it('falls back to the observation date', () => {
    const ev = testEvidence({ observedAt: '2026-05-01T00:00:00Z', lastVerifiedAt: undefined });
    expect(evidenceAgeDays(ev, NOW)).toBe(31);
  });
});

describe('isStale', () => {
  it('marks a listing price stale after its 30-day window', () => {
    const ev = testEvidence({
      source: testSource({ type: 'listing' }),
      observedAt: '2026-03-01T00:00:00Z',
      lastVerifiedAt: undefined,
    });
    expect(isStale(ev, NOW)).toBe(true);
  });

  it('keeps a RERA filing fresh well past a listing window', () => {
    const ev = testEvidence({
      source: testSource({ type: 'rera' }),
      observedAt: '2026-03-01T00:00:00Z',
      lastVerifiedAt: undefined,
    });
    expect(isStale(ev, NOW)).toBe(false);
  });
});

describe('effectiveConfidence', () => {
  it('decays with age against the source half-life', () => {
    const fresh = testEvidence({ lastVerifiedAt: NOW });
    const old = testEvidence({
      source: testSource({ type: 'listing' }),
      lastVerifiedAt: '2026-04-17T00:00:00Z', // exactly 45 days = one listing half-life
    });
    expect(effectiveConfidence(fresh, NOW)).toBeGreaterThan(effectiveConfidence(old, NOW));
    expect(effectiveConfidence(old, NOW)).toBeCloseTo(0.45, 2);
  });

  it('scales by source trust', () => {
    const trusted = testEvidence({ lastVerifiedAt: NOW, source: testSource({ trust: 1 }) });
    const shaky = testEvidence({ lastVerifiedAt: NOW, source: testSource({ trust: 0.5 }) });
    expect(effectiveConfidence(shaky, NOW)).toBeCloseTo(effectiveConfidence(trusted, NOW) / 2, 3);
  });

  it('halves confidence for disputed evidence', () => {
    const clean = testEvidence({ lastVerifiedAt: NOW });
    const disputed = testEvidence({ lastVerifiedAt: NOW, disputed: true });
    expect(effectiveConfidence(disputed, NOW)).toBeCloseTo(effectiveConfidence(clean, NOW) / 2, 3);
  });

  it('never leaves the 0..1 range', () => {
    const ev = testEvidence({
      confidence: 1,
      lastVerifiedAt: NOW,
      source: testSource({ trust: 1 }),
    });
    expect(effectiveConfidence(ev, NOW)).toBeLessThanOrEqual(1);
    expect(effectiveConfidence(ev, NOW)).toBeGreaterThanOrEqual(0);
  });
});

describe('summarizeFreshness', () => {
  it('returns a zeroed summary for an empty set rather than NaN', () => {
    const s = summarizeFreshness([], NOW);
    expect(s.totalCount).toBe(0);
    expect(s.meanConfidence).toBe(0);
    expect(Number.isNaN(s.stalePercentage)).toBe(false);
  });

  it('counts stale records and reports a percentage', () => {
    const summary = summarizeFreshness(
      [
        testEvidence({
          source: testSource({ type: 'listing' }),
          lastVerifiedAt: '2026-01-01T00:00:00Z',
        }),
        testEvidence({ source: testSource({ type: 'rera' }), lastVerifiedAt: NOW }),
      ],
      NOW,
    );
    expect(summary.staleCount).toBe(1);
    expect(summary.stalePercentage).toBe(50);
  });
});

describe('data status helpers', () => {
  it('flags a set containing demo data', () => {
    expect(containsDemoData([testEvidence({ dataStatus: 'demo' })])).toBe(true);
    expect(containsDemoData([testEvidence({ dataStatus: 'verified' })])).toBe(false);
  });

  it('treats everything except demo as real', () => {
    expect(isRealData('verified')).toBe(true);
    expect(isRealData('derived')).toBe(true);
    expect(isRealData('estimated')).toBe(true);
    expect(isRealData('demo')).toBe(false);
  });
});
