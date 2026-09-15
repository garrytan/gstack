import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANALYTICS_EVENTS,
  FUNNEL_STAGE,
  __resetAnalytics,
  pendingAnalytics,
  setAnalyticsTransport,
  track,
} from '@/lib/analytics';
import type { AnalyticsPayload } from '@/lib/analytics';
import { formatINR, formatPercent, formatRelative, formatSignedPercent } from '@/lib/utils';

describe('analytics', () => {
  beforeEach(() => __resetAnalytics());
  afterEach(() => __resetAnalytics());

  it('assigns every declared event a funnel stage', () => {
    for (const event of ANALYTICS_EVENTS) {
      expect(FUNNEL_STAGE[event]).toBeGreaterThan(0);
    }
  });

  it('covers the full funnel from search through to close', () => {
    const stages = new Set(Object.values(FUNNEL_STAGE));
    for (let stage = 1; stage <= 8; stage += 1) {
      expect(stages.has(stage), `no event at funnel stage ${stage}`).toBe(true);
    }
  });

  it('buffers events until a transport is installed, then flushes in order', () => {
    track('search_submitted', { query: 'first' });
    track('property_viewed', { propertyId: 'p1' });
    expect(pendingAnalytics()).toHaveLength(2);

    const received: AnalyticsPayload[] = [];
    setAnalyticsTransport({ send: (p) => received.push(p) });

    expect(received.map((r) => r.event)).toEqual(['search_submitted', 'property_viewed']);
    expect(pendingAnalytics()).toHaveLength(0);
  });

  it('sends straight through once a transport exists', () => {
    const received: AnalyticsPayload[] = [];
    setAnalyticsTransport({ send: (p) => received.push(p) });
    track('property_saved', { propertyId: 'p1' });
    expect(received).toHaveLength(1);
    expect(received[0]!.stage).toBe(FUNNEL_STAGE.property_saved);
  });

  it('bounds the buffer so a transportless session cannot grow without limit', () => {
    for (let i = 0; i < 500; i += 1) track('result_clicked', { i });
    expect(pendingAnalytics().length).toBeLessThanOrEqual(200);
  });
});

describe('Indian currency formatting', () => {
  it('reads large figures in crore', () => {
    expect(formatINR(16_500_000)).toBe('₹1.65 Cr');
  });

  it('reads mid figures in lakh', () => {
    expect(formatINR(7_600_000)).toBe('₹76.00 L');
  });

  it('falls back to grouped digits below a lakh', () => {
    expect(formatINR(45_000)).toBe('₹45,000');
  });

  it('returns an em dash rather than NaN for a bad input', () => {
    expect(formatINR(Number.NaN)).toBe('—');
  });

  it('can render the exact figure when asked', () => {
    expect(formatINR(16_500_000, { compact: false })).toBe('₹1,65,00,000');
  });
});

describe('percent and relative formatting', () => {
  it('signs a positive deviation', () => {
    expect(formatSignedPercent(8.4)).toBe('+8.4%');
    expect(formatSignedPercent(-8.4)).toBe('-8.4%');
  });

  it('renders an unknown as an em dash, never as zero', () => {
    expect(formatPercent(undefined)).toBe('—');
    expect(formatSignedPercent(undefined)).toBe('—');
  });

  it('describes recency in human terms', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(formatRelative('2026-06-01T00:00:00Z', now)).toBe('today');
    expect(formatRelative('2026-05-29T00:00:00Z', now)).toBe('3 days ago');
    expect(formatRelative('2026-01-01T00:00:00Z', now)).toBe('5 months ago');
    expect(formatRelative('2027-06-01T00:00:00Z', now)).toBe('1.0 years from now');
  });

  it('reports unknown for an unparseable or missing date', () => {
    expect(formatRelative(undefined)).toBe('unknown');
    expect(formatRelative('not-a-date')).toBe('unknown');
  });
});
