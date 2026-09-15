import { describe, expect, it } from 'vitest';
import { assessRisk } from '@/domain/risk/engine';
import { RISK_DIMENSIONS, bandFor } from '@/domain/risk/types';
import { NOW, testDeveloper, testLocality, testProject, testProperty } from './support/factories';

describe('bandFor', () => {
  it('maps severity onto named bands', () => {
    expect(bandFor(0.1)).toBe('low');
    expect(bandFor(0.3)).toBe('moderate');
    expect(bandFor(0.5)).toBe('elevated');
    expect(bandFor(0.8)).toBe('high');
  });
});

describe('assessRisk', () => {
  const full = () => ({
    property: testProperty(),
    project: testProject(),
    developer: testDeveloper(),
    locality: testLocality(),
    now: NOW,
  });

  it('reports every declared dimension', () => {
    const r = assessRisk(full());
    expect(r.dimensions.map((d) => d.dimension).sort()).toEqual([...RISK_DIMENSIONS].sort());
  });

  it('marks dimensions without data as unknown and excludes them from the composite', () => {
    const r = assessRisk({ property: testProperty(), now: NOW });
    const unknown = r.dimensions.filter((d) => !d.hasData);
    expect(unknown.length).toBeGreaterThan(0);
    for (const d of unknown) {
      expect(d.band).toBe('unknown');
      expect(d.confidence).toBe(0);
    }
    expect(r.coverage).toBeLessThan(1);
  });

  it('scores an unregistered project as high legal risk', () => {
    const project = testProject();
    const phase = {
      ...project.phases[0]!,
      rera: { number: '', state: 'Karnataka', status: 'notRegistered' as const },
    };
    const r = assessRisk({ ...full(), project: { ...project, phases: [phase] } });
    const legal = r.dimensions.find((d) => d.dimension === 'legal')!;
    expect(legal.severity).toBeGreaterThan(0.75);
    expect(legal.drivers.join(' ')).toContain('not RERA registered');
  });

  it('treats a completed property as carrying no construction risk', () => {
    const r = assessRisk({
      ...full(),
      property: testProperty({ constructionStatus: 'readyToMove' }),
    });
    const construction = r.dimensions.find((d) => d.dimension === 'construction')!;
    expect(construction.band).toBe('low');
    expect(construction.hasData).toBe(true);
  });

  it('raises construction risk when possession has already slipped', () => {
    const project = testProject();
    const slipped = {
      ...project.phases[0]!,
      promisedPossession: '2025-01-01T00:00:00.000Z',
      currentPossession: '2027-06-01T00:00:00.000Z',
      completionPercent: 30,
    };
    const base = assessRisk(full()).dimensions.find((d) => d.dimension === 'construction')!;
    const worse = assessRisk({
      ...full(),
      project: { ...project, phases: [slipped] },
    }).dimensions.find((d) => d.dimension === 'construction')!;
    expect(worse.severity).toBeGreaterThan(base.severity);
    expect(worse.drivers.join(' ')).toContain('slipped');
  });

  it('flags a locality whose upside depends on unfunded infrastructure', () => {
    const locality = testLocality({
      pipeline: [{ name: 'Proposed ring road', type: 'road', status: 'announced' }],
    });
    const r = assessRisk({ ...full(), locality });
    const infra = r.dimensions.find((d) => d.dimension === 'infrastructure')!;
    expect(infra.severity).toBeGreaterThan(0.5);
    expect(infra.drivers.join(' ')).toContain('not funded');
  });

  it('surfaces material risks separately for the verdict to cite', () => {
    const project = testProject();
    const phase = {
      ...project.phases[0]!,
      rera: { number: '', state: 'KA', status: 'lapsed' as const },
    };
    const r = assessRisk({ ...full(), project: { ...project, phases: [phase] } });
    expect(r.materialRisks.length).toBeGreaterThan(0);
    expect(r.materialRisks.every((d) => d.hasData)).toBe(true);
  });

  it('gives every dimension with data at least one human-readable driver', () => {
    const r = assessRisk(full());
    for (const d of r.dimensions.filter((x) => x.hasData)) {
      expect(d.drivers.length).toBeGreaterThan(0);
      expect(d.methodology.length).toBeGreaterThan(10);
    }
  });

  it('keeps composite severity inside 0..1', () => {
    const r = assessRisk(full());
    expect(r.compositeSeverity).toBeGreaterThanOrEqual(0);
    expect(r.compositeSeverity).toBeLessThanOrEqual(1);
  });
});
