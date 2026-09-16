import { describe, expect, it } from 'vitest';
import { analyseYield } from '@/domain/tools/rental-yield';
import { amortisationSchedule, monthlyEmi } from '@/domain/investment/calculator';

const base = {
  purchasePrice: 1_00_00_000,
  acquisitionCosts: 8_00_000,
  monthlyRent: 35_000,
  vacancyPercent: 0,
  monthlyMaintenance: 0,
  annualPropertyTax: 0,
  annualInsurance: 0,
  annualOtherCosts: 0,
};

describe('analyseYield', () => {
  it('computes the broker figure on price alone', () => {
    // 4.2 lakh a year on a crore.
    expect(analyseYield(base).grossYieldPercent).toBeCloseTo(4.2, 6);
  });

  it('computes net yield on everything deployed, not just the price', () => {
    const r = analyseYield(base);
    expect(r.capitalDeployed).toBe(1_08_00_000);
    // With no costs, net income is the rent, but the denominator is larger.
    expect(r.netYieldPercent).toBeCloseTo((4_20_000 / 1_08_00_000) * 100, 6);
    expect(r.netYieldPercent ?? 0).toBeLessThan(r.grossYieldPercent ?? 0);
  });

  it('takes vacancy out of the rent before anything else', () => {
    const r = analyseYield({ ...base, vacancyPercent: 10 });
    expect(r.effectiveAnnualRent).toBeCloseTo(3_78_000, 6);
    // Gross yield is deliberately untouched by vacancy — it is the quoted number.
    expect(r.grossYieldPercent).toBeCloseTo(4.2, 6);
  });

  it('clamps an absurd vacancy rather than producing negative rent', () => {
    expect(analyseYield({ ...base, vacancyPercent: 150 }).effectiveAnnualRent).toBe(0);
    expect(analyseYield({ ...base, vacancyPercent: -20 }).effectiveAnnualRent).toBeCloseTo(
      4_20_000,
      6,
    );
  });

  it('subtracts operating costs from net income only', () => {
    const r = analyseYield({ ...base, monthlyMaintenance: 5_000, annualPropertyTax: 12_000 });
    expect(r.annualOperatingCost).toBe(72_000);
    expect(r.netAnnualIncome).toBeCloseTo(4_20_000 - 72_000, 6);
  });

  it('reports what share of the rent never reaches the owner', () => {
    const r = analyseYield({ ...base, vacancyPercent: 10, monthlyMaintenance: 5_000 });
    expect(r.costRatio).toBeGreaterThan(0);
    expect(r.costRatio).toBeLessThan(1);
  });

  it('withholds every derived figure when the rent is unknown', () => {
    const r = analyseYield({ ...base, monthlyRent: 0 });
    expect(r.grossAnnualRent).toBeUndefined();
    expect(r.netAnnualIncome).toBeUndefined();
    expect(r.grossYieldPercent).toBeUndefined();
    expect(r.netYieldPercent).toBeUndefined();
  });

  it('withholds payback rather than claiming a huge number when income is negative', () => {
    const loss = analyseYield({ ...base, monthlyMaintenance: 60_000 });
    expect(loss.netAnnualIncome ?? 0).toBeLessThan(0);
    expect(loss.paybackYears).toBeUndefined();
  });
});

describe('amortisationSchedule', () => {
  const principal = 80_00_000;
  const rate = 8.6;
  const tenure = 20;

  it('runs for the tenure and clears the loan', () => {
    const rows = amortisationSchedule(principal, rate, tenure);
    expect(rows).toHaveLength(tenure);
    expect(rows.at(-1)?.closingBalance ?? 1).toBeLessThan(1);
  });

  it('opens at the principal and never goes negative', () => {
    const rows = amortisationSchedule(principal, rate, tenure);
    expect(rows[0]?.openingBalance).toBe(principal);
    expect(rows.every((r) => r.closingBalance >= 0)).toBe(true);
  });

  it('is continuous — each year opens where the last one closed', () => {
    const rows = amortisationSchedule(principal, rate, tenure);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.openingBalance).toBeCloseTo(rows[i - 1]?.closingBalance ?? -1, 2);
    }
  });

  it('shifts from interest to principal over the life of the loan', () => {
    const rows = amortisationSchedule(principal, rate, tenure);
    const first = rows[0];
    const last = rows.at(-1);
    expect(first && last).toBeTruthy();
    expect((first?.interest ?? 0) > (first?.principalPaid ?? 0)).toBe(true);
    expect((last?.principalPaid ?? 0) > (last?.interest ?? 0)).toBe(true);
  });

  it('accumulates interest to the same total the instalments imply', () => {
    const rows = amortisationSchedule(principal, rate, tenure);
    const paid = monthlyEmi(principal, rate, tenure) * 12 * tenure;
    // Total interest is what you paid minus what you borrowed, within the
    // rounding the final capped instalment introduces.
    expect(rows.at(-1)?.cumulativeInterest ?? 0).toBeCloseTo(paid - principal, -2);
  });

  it('returns nothing rather than a fake row for a loan that does not exist', () => {
    expect(amortisationSchedule(0, rate, tenure)).toEqual([]);
    expect(amortisationSchedule(principal, rate, 0)).toEqual([]);
  });
});
