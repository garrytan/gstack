import { describe, expect, it } from 'vitest';
import {
  analyseQuote,
  carpetEfficiency,
  carpetFrom,
  compareQuotes,
  loadingFactor,
  superBuiltUpFrom,
} from '@/domain/tools/area';

describe('loadingFactor', () => {
  it('expresses loading against carpet, the way builders quote it', () => {
    // 1000 carpet sold as 1250 super built-up is "25% loading".
    expect(loadingFactor(1000, 1250)).toBeCloseTo(0.25, 6);
  });

  it('is zero when there is no loading at all', () => {
    expect(loadingFactor(1000, 1000)).toBe(0);
  });

  it('refuses rather than returning a negative loading', () => {
    // Super built-up below carpet is a typo or a different definition of
    // carpet, not a flat with negative common area.
    expect(loadingFactor(1250, 1000)).toBeUndefined();
  });

  it('returns undefined for absent or zero inputs rather than a plausible zero', () => {
    expect(loadingFactor(0, 1250)).toBeUndefined();
    expect(loadingFactor(1000, 0)).toBeUndefined();
  });
});

describe('carpetEfficiency', () => {
  it('is the share of what you are billed for that you can stand on', () => {
    expect(carpetEfficiency(1000, 1250)).toBeCloseTo(0.8, 6);
  });

  it('is the inverse view of loading', () => {
    const eff = carpetEfficiency(1210, 1685);
    const load = loadingFactor(1210, 1685);
    expect(eff).toBeDefined();
    expect(load).toBeDefined();
    expect(1 / (eff ?? 1) - 1).toBeCloseTo(load ?? 0, 6);
  });
});

describe('area conversions', () => {
  it('round-trips carpet to super built-up and back', () => {
    const sba = superBuiltUpFrom(1000, 25);
    expect(sba).toBeCloseTo(1250, 6);
    expect(carpetFrom(sba ?? 0, 25)).toBeCloseTo(1000, 6);
  });

  it('refuses a negative loading percentage', () => {
    expect(superBuiltUpFrom(1000, -5)).toBeUndefined();
    expect(carpetFrom(1250, -5)).toBeUndefined();
  });
});

describe('analyseQuote', () => {
  const quote = {
    label: 'Tower A',
    totalPrice: 1_00_00_000,
    superBuiltUpSqFt: 1250,
    carpetAreaSqFt: 1000,
  };

  it('separates the advertised rate from the carpet rate', () => {
    const a = analyseQuote(quote);
    expect(a.quotedPsf).toBeCloseTo(8000, 6);
    expect(a.carpetPsf).toBeCloseTo(10_000, 6);
  });

  it('prices the loading, because nobody quotes that number', () => {
    // 250 sqft of common area at the advertised ₹8,000.
    expect(analyseQuote(quote).loadingCost).toBeCloseTo(20_00_000, 6);
  });

  it('withholds every derived figure when the area is missing', () => {
    const a = analyseQuote({ ...quote, carpetAreaSqFt: 0 });
    expect(a.carpetPsf).toBeUndefined();
    expect(a.loading).toBeUndefined();
    expect(a.efficiency).toBeUndefined();
  });
});

describe('compareQuotes', () => {
  // The case the tool exists for: the cheaper advertised rate is the worse
  // flat once you pay per usable square foot.
  const cheapHeadline = {
    label: 'Cheaper headline',
    totalPrice: 1_00_00_000,
    superBuiltUpSqFt: 1400,
    carpetAreaSqFt: 910, // 35% loading
  };
  const dearHeadline = {
    label: 'Dearer headline',
    totalPrice: 1_00_00_000,
    superBuiltUpSqFt: 1250,
    carpetAreaSqFt: 1040, // 20% loading
  };

  it('flags when the advertised winner is not the carpet winner', () => {
    const c = compareQuotes([cheapHeadline, dearHeadline]);
    expect(c.bestOnQuoted?.label).toBe('Cheaper headline');
    expect(c.bestOnCarpet?.label).toBe('Dearer headline');
    expect(c.headlineMisleads).toBe(true);
  });

  it('does not cry wolf when the two agree', () => {
    const c = compareQuotes([
      dearHeadline,
      { ...dearHeadline, label: 'Clearly worse', totalPrice: 1_20_00_000 },
    ]);
    expect(c.headlineMisleads).toBe(false);
  });

  it('reports the spread between the best and worst carpet rate', () => {
    const c = compareQuotes([cheapHeadline, dearHeadline]);
    const rates = c.quotes.map((q) => q.carpetPsf ?? 0);
    expect(c.carpetSpread).toBeCloseTo(Math.max(...rates) - Math.min(...rates), 6);
  });

  it('withholds a spread when only one quote can be compared', () => {
    expect(compareQuotes([dearHeadline]).carpetSpread).toBeUndefined();
  });

  it('ignores quotes it cannot put on a carpet basis rather than guessing one', () => {
    const c = compareQuotes([dearHeadline, { ...cheapHeadline, carpetAreaSqFt: 0 }]);
    expect(c.bestOnCarpet?.label).toBe('Dearer headline');
    expect(c.carpetSpread).toBeUndefined();
  });
});
