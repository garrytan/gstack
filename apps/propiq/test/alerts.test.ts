import { describe, expect, it } from 'vitest';
import { evaluateAlerts } from '@/domain/alerts/engine';
import { ALERT_THRESHOLDS } from '@/domain/alerts/types';
import type { PropertySnapshot } from '@/domain/alerts/types';
import { NOW } from './support/factories';

const snap = (overrides: Partial<PropertySnapshot> = {}): PropertySnapshot => ({
  propertyId: 'prop-1',
  capturedAt: '2026-05-01T00:00:00.000Z',
  askingPrice: 16_000_000,
  fairValueMid: 15_500_000,
  score: 74,
  decision: 'BUY',
  reraStatus: 'registered',
  possessionDate: '2027-06-01T00:00:00.000Z',
  compositeRiskBand: 'low',
  materialRiskDimensions: [],
  stalePercentage: 10,
  ...overrides,
});

describe('evaluateAlerts', () => {
  it('fires nothing when nothing material changed', () => {
    expect(evaluateAlerts(snap(), snap(), NOW)).toHaveLength(0);
  });

  it('ignores a price move below the published threshold', () => {
    const after = snap({ askingPrice: 16_100_000 }); // +0.6%
    expect(
      evaluateAlerts(snap(), after, NOW).find((a) => a.kind === 'priceChange'),
    ).toBeUndefined();
  });

  it('fires on a price cut above the threshold', () => {
    const after = snap({ askingPrice: 15_000_000 }); // -6.25%
    const alert = evaluateAlerts(snap(), after, NOW).find((a) => a.kind === 'priceChange');
    expect(alert).toBeDefined();
    expect(alert!.headline).toContain('dropped');
    expect(alert!.rule).toContain(String(ALERT_THRESHOLDS.priceChangePercent));
  });

  it('treats a verdict falling away from BUY as urgent', () => {
    const alert = evaluateAlerts(snap(), snap({ decision: 'WATCH' }), NOW).find(
      (a) => a.kind === 'verdictChange',
    );
    expect(alert!.severity).toBe('urgent');
  });

  it('treats a move to AVOID as urgent', () => {
    const alert = evaluateAlerts(
      snap({ decision: 'WATCH' }),
      snap({ decision: 'AVOID' }),
      NOW,
    ).find((a) => a.kind === 'verdictChange');
    expect(alert!.severity).toBe('urgent');
  });

  it('ignores a score wobble inside the confidence band', () => {
    const alerts = evaluateAlerts(snap(), snap({ score: 76 }), NOW);
    expect(alerts.find((a) => a.kind === 'scoreChange')).toBeUndefined();
  });

  it('fires when a score moves more than the band would explain', () => {
    const alert = evaluateAlerts(snap(), snap({ score: 66 }), NOW).find(
      (a) => a.kind === 'scoreChange',
    );
    expect(alert).toBeDefined();
    expect(alert!.headline).toContain('-8');
  });

  it('reports a withdrawn score as an event in its own right', () => {
    const alert = evaluateAlerts(snap(), snap({ score: undefined }), NOW).find(
      (a) => a.kind === 'scoreChange',
    );
    expect(alert!.after).toBe('not published');
    expect(alert!.severity).toBe('attention');
  });

  it('treats a possession slip as urgent and an early handover as informational', () => {
    const slipped = evaluateAlerts(
      snap(),
      snap({ possessionDate: '2027-12-01T00:00:00.000Z' }),
      NOW,
    ).find((a) => a.kind === 'possessionSlip');
    expect(slipped!.severity).toBe('urgent');

    const early = evaluateAlerts(
      snap(),
      snap({ possessionDate: '2027-01-01T00:00:00.000Z' }),
      NOW,
    ).find((a) => a.kind === 'possessionSlip');
    expect(early!.severity).toBe('info');
  });

  it('ignores a possession move below the threshold', () => {
    const after = snap({ possessionDate: '2027-06-10T00:00:00.000Z' }); // 9 days
    expect(
      evaluateAlerts(snap(), after, NOW).find((a) => a.kind === 'possessionSlip'),
    ).toBeUndefined();
  });

  it('treats a RERA registration lapsing as urgent', () => {
    const alert = evaluateAlerts(snap(), snap({ reraStatus: 'lapsed' }), NOW).find(
      (a) => a.kind === 'reraChange',
    );
    expect(alert!.severity).toBe('urgent');
  });

  it('treats a RERA registration being restored as attention, not urgent', () => {
    const alert = evaluateAlerts(snap({ reraStatus: 'expired' }), snap(), NOW).find(
      (a) => a.kind === 'reraChange',
    );
    expect(alert!.severity).toBe('attention');
  });

  it('fires when a risk dimension becomes material', () => {
    const alert = evaluateAlerts(
      snap(),
      snap({ materialRiskDimensions: ['construction'] }),
      NOW,
    ).find((a) => a.rule === 'risk.construction.becameMaterial');
    expect(alert).toBeDefined();
  });

  it('does not re-fire for a dimension that was already material', () => {
    const before = snap({ materialRiskDimensions: ['construction'] });
    const after = snap({ materialRiskDimensions: ['construction'] });
    expect(
      evaluateAlerts(before, after, NOW).find((a) => a.rule.includes('becameMaterial')),
    ).toBeUndefined();
  });

  it('fires once when evidence crosses the staleness threshold', () => {
    const crossed = evaluateAlerts(
      snap({ stalePercentage: 20 }),
      snap({ stalePercentage: 55 }),
      NOW,
    );
    expect(crossed.find((a) => a.kind === 'evidenceStale')).toBeDefined();

    // Already over the line — no repeat alert.
    const alreadyStale = evaluateAlerts(
      snap({ stalePercentage: 50 }),
      snap({ stalePercentage: 60 }),
      NOW,
    );
    expect(alreadyStale.find((a) => a.kind === 'evidenceStale')).toBeUndefined();
  });

  it('orders urgent alerts before attention before info', () => {
    const alerts = evaluateAlerts(
      snap(),
      snap({ decision: 'AVOID', fairValueMid: 13_000_000, askingPrice: 15_000_000 }),
      NOW,
    );
    const severities = alerts.map((a) => a.severity);
    expect(severities).toEqual(
      [...severities].sort(
        (a, b) =>
          ({ urgent: 0, attention: 1, info: 2 })[a] - { urgent: 0, attention: 1, info: 2 }[b],
      ),
    );
    expect(severities[0]).toBe('urgent');
  });

  it('gives every alert a traceable rule and a before/after pair', () => {
    const alerts = evaluateAlerts(
      snap(),
      snap({ askingPrice: 14_000_000, decision: 'NEGOTIATE', score: 62, reraStatus: 'expired' }),
      NOW,
    );
    expect(alerts.length).toBeGreaterThan(2);
    for (const a of alerts) {
      expect(a.rule.length).toBeGreaterThan(3);
      expect(a.before.length).toBeGreaterThan(0);
      expect(a.after.length).toBeGreaterThan(0);
      expect(a.detail.length).toBeGreaterThan(10);
    }
  });
});
