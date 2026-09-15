/**
 * Integration tests over the fixture adapter and the full intelligence chain.
 *
 * These exercise the wiring the unit tests deliberately skip: repository →
 * valuation → risk → scoring → decision, on the actual demo dataset.
 */

import { describe, expect, it } from 'vitest';

process.env.PROPIQ_DATA_ADAPTER = 'fixture';

import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { FixturePropertyRepository } from '@/data/fixtures/adapter';
import { DEMO_LOCALITIES } from '@/data/fixtures/localities';
import { DEMO_DEVELOPERS, DEMO_PROJECTS, DEMO_PROPERTIES } from '@/data/fixtures/properties';
import { buildPropertyIntelligence, marketDriftFor } from '@/server/intelligence';

const NOW = '2026-06-01T00:00:00.000Z';
const repo = new FixturePropertyRepository();

describe('fixture dataset integrity', () => {
  it('labels every property, locality and evidence record as demo data', () => {
    for (const p of DEMO_PROPERTIES) {
      expect(p.dataStatus).toBe('demo');
      for (const e of p.evidence) expect(e.dataStatus).toBe('demo');
    }
    for (const l of DEMO_LOCALITIES) {
      expect(l.dataStatus).toBe('demo');
      for (const e of l.evidence) expect(e.dataStatus).toBe('demo');
    }
  });

  it('resolves every property to an existing project, developer and locality', () => {
    for (const p of DEMO_PROPERTIES) {
      const project = DEMO_PROJECTS.find((x) => x.id === p.projectId);
      expect(project, `project missing for ${p.id}`).toBeDefined();
      expect(DEMO_DEVELOPERS.find((d) => d.id === project!.developerId)).toBeDefined();
      expect(DEMO_LOCALITIES.find((l) => l.id === p.localityId)).toBeDefined();
    }
  });

  it('declares no commercial relationship on any demo record', () => {
    for (const p of DEMO_PROPERTIES) {
      expect(p.commercial.paidPlacement).toBe(false);
      expect(p.commercial.developerRelationship).toBe(false);
    }
  });

  it('keeps carpet area strictly below the quoted super built-up area', () => {
    for (const p of DEMO_PROPERTIES) {
      expect(p.carpetAreaSqFt!).toBeLessThan(p.areaSqFt);
      expect(p.carpetAreaSqFt! / p.areaSqFt).toBeGreaterThan(0.5);
    }
  });
});

describe('FixturePropertyRepository', () => {
  it('declares itself as a demo source', () => {
    expect(repo.servesDemoData).toBe(true);
    expect(repo.adapterName).toBe('fixture');
  });

  it('paginates search results', async () => {
    const first = await repo.search({ pageSize: 5, page: 1 });
    const second = await repo.search({ pageSize: 5, page: 2 });
    expect(first.items).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(DEMO_PROPERTIES.length);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it('filters on price, bedrooms and locality', async () => {
    const result = await repo.search({ priceMax: 11_000_000, bedroomsMin: 3 });
    for (const p of result.items) {
      expect(p.askingPrice).toBeLessThanOrEqual(11_000_000);
      expect(p.bedrooms).toBeGreaterThanOrEqual(3);
    }
  });

  it('sorts by price in both directions', async () => {
    const asc = await repo.search({ sort: 'priceAsc', pageSize: 48 });
    const desc = await repo.search({ sort: 'priceDesc', pageSize: 48 });
    expect(asc.items[0]!.askingPrice).toBeLessThan(asc.items.at(-1)!.askingPrice);
    expect(desc.items[0]!.askingPrice).toBeGreaterThan(desc.items.at(-1)!.askingPrice);
  });

  it('matches free text against title and project name', async () => {
    const result = await repo.search({ text: 'tamarind' });
    expect(result.items.length).toBeGreaterThan(0);
    for (const p of result.items) expect(p.projectId).toContain('tamarind');
  });

  it('preserves caller ordering in getManyByIds', async () => {
    const ids = [asId<PropertyId>('prop-kg-2a'), asId<PropertyId>('prop-th-3a')];
    const result = await repo.getManyByIds(ids);
    expect(result.map((p) => p.id)).toEqual(ids);
  });

  it('returns alternatives with the same bedroom count and a nearby price', async () => {
    const subject = DEMO_PROPERTIES.find((p) => p.id === 'prop-nm-3a')!;
    const alternatives = await repo.getAlternatives(subject.id);
    expect(alternatives.length).toBeGreaterThan(0);
    for (const a of alternatives) {
      expect(a.id).not.toBe(subject.id);
      expect(a.bedrooms).toBe(subject.bedrooms);
    }
  });

  it('returns a sparse comparable set for the deliberately thin record', async () => {
    const comps = await repo.getComparables(asId<PropertyId>('prop-sv-2a'));
    expect(comps.length).toBeLessThan(2);
  });
});

describe('marketDriftFor', () => {
  it('derives drift from the locality price history when available', () => {
    const drift = marketDriftFor(DEMO_LOCALITIES[0]);
    expect(drift.derived).toBe(true);
    expect(drift.rate).toBeGreaterThan(0);
  });

  it('falls back to a stated default with no history', () => {
    const drift = marketDriftFor(undefined);
    expect(drift.derived).toBe(false);
    expect(drift.rate).toBe(5);
  });
});

describe('buildPropertyIntelligence', () => {
  it('returns undefined for an unknown property rather than throwing', async () => {
    expect(await buildPropertyIntelligence(asId<PropertyId>('nope'), { now: NOW })).toBeUndefined();
  });

  it('assembles the full chain for a well-evidenced property', async () => {
    const intel = await buildPropertyIntelligence(asId<PropertyId>('prop-nm-3a'), { now: NOW });
    expect(intel).toBeDefined();
    expect(intel!.project).toBeDefined();
    expect(intel!.developer).toBeDefined();
    expect(intel!.locality).toBeDefined();
    expect(intel!.valuation.insufficientEvidence).toBe(false);
    expect(intel!.risk.dimensions.length).toBeGreaterThan(0);
    expect(intel!.score.score).toBeDefined();
    expect(intel!.decision.decision).toBeDefined();
    expect(intel!.investment.scenarios).toHaveLength(3);
  });

  it('flags demo data on every fixture-backed payload', async () => {
    const intel = await buildPropertyIntelligence(asId<PropertyId>('prop-nm-3a'), { now: NOW });
    expect(intel!.usesDemoData).toBe(true);
  });

  it('returns INSUFFICIENT_EVIDENCE for the deliberately thin record', async () => {
    const intel = await buildPropertyIntelligence(asId<PropertyId>('prop-sv-2a'), { now: NOW });
    expect(intel!.decision.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(intel!.valuation.insufficientEvidence).toBe(true);
  });

  it('reaches AVOID on the unregistered, badly delayed project', async () => {
    const intel = await buildPropertyIntelligence(asId<PropertyId>('prop-cc-3a'), { now: NOW });
    expect(['AVOID', 'WATCH']).toContain(intel!.decision.decision);
    const legal = intel!.risk.dimensions.find((d) => d.dimension === 'legal')!;
    expect(legal.severity).toBeGreaterThan(0.4);
  });

  it('gives every verdict a deciding rule and a headline', async () => {
    for (const p of DEMO_PROPERTIES) {
      const intel = await buildPropertyIntelligence(p.id, { now: NOW });
      expect(intel!.decision.decidingRule.length).toBeGreaterThan(0);
      expect(intel!.decision.headline.length).toBeGreaterThan(10);
    }
  });

  it('produces a different verdict mix across the dataset, not one label for everything', async () => {
    const decisions = new Set<string>();
    for (const p of DEMO_PROPERTIES) {
      const intel = await buildPropertyIntelligence(p.id, { now: NOW });
      decisions.add(intel!.decision.decision);
    }
    expect(decisions.size).toBeGreaterThan(1);
  });

  it('is deterministic for a fixed clock', async () => {
    const a = await buildPropertyIntelligence(asId<PropertyId>('prop-th-3a'), { now: NOW });
    const b = await buildPropertyIntelligence(asId<PropertyId>('prop-th-3a'), { now: NOW });
    expect(a!.score.score).toBe(b!.score.score);
    expect(a!.valuation.mid).toBe(b!.valuation.mid);
    expect(a!.decision.decision).toBe(b!.decision.decision);
  });

  it('scores the same property differently for an investor than a homebuyer', async () => {
    const home = await buildPropertyIntelligence(asId<PropertyId>('prop-vc-3a'), {
      now: NOW,
      persona: 'homebuyer',
    });
    const inv = await buildPropertyIntelligence(asId<PropertyId>('prop-vc-3a'), {
      now: NOW,
      persona: 'investor',
    });
    expect(home!.score.persona).toBe('homebuyer');
    expect(inv!.score.persona).toBe('investor');
    expect(home!.score.score).not.toBe(inv!.score.score);
  });

  it('never returns negotiation guidance without a usable valuation', async () => {
    const intel = await buildPropertyIntelligence(asId<PropertyId>('prop-sv-2a'), { now: NOW });
    expect(intel!.negotiation).toBeUndefined();
  });
});
