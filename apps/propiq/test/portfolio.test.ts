import { describe, expect, it } from 'vitest';
import {
  annualisedReturnPercent,
  assetMetrics,
  holdingYears,
  summarisePortfolio,
} from '@/domain/portfolio/calculator';
import type { PortfolioAsset } from '@/domain/portfolio/types';
import { asId } from '@/domain/shared/types';
import type { UserId } from '@/domain/shared/types';
import { NOW } from './support/factories';

const asset = (overrides: Partial<PortfolioAsset> = {}): PortfolioAsset => ({
  id: 'asset-1',
  userId: asId<UserId>('user-1'),
  label: 'Whitefield 3BHK',
  purchasePrice: 10_000_000,
  purchaseDate: '2021-06-01',
  costBasis: 10_800_000,
  outstandingLoan: 6_000_000,
  monthlyRent: 35_000,
  monthlyExpenses: 8_000,
  currentEstimate: 14_000_000,
  valuationSource: 'estimated',
  createdAt: NOW,
  ...overrides,
});

describe('holdingYears', () => {
  it('measures elapsed years from the purchase date', () => {
    expect(holdingYears('2021-06-01', NOW)).toBeCloseTo(5, 1);
  });

  it('never returns a negative holding for a future purchase date', () => {
    expect(holdingYears('2030-01-01', NOW)).toBe(0);
  });
});

describe('annualisedReturnPercent', () => {
  it('computes CAGR on the cost basis', () => {
    // 100 → 121 over 2 years is 10% a year.
    expect(annualisedReturnPercent(100, 121, 2)).toBeCloseTo(10, 2);
  });

  it('refuses to annualise a holding under three months', () => {
    expect(annualisedReturnPercent(100, 110, 0.1)).toBeUndefined();
  });

  it('returns undefined for a zero cost basis rather than dividing by zero', () => {
    expect(annualisedReturnPercent(0, 100, 2)).toBeUndefined();
  });
});

describe('assetMetrics', () => {
  it('computes equity as current value less outstanding debt', () => {
    const m = assetMetrics(asset(), NOW);
    expect(m.equity).toBe(8_000_000);
  });

  it('computes unrealised gain against the cost basis, not the purchase price', () => {
    const m = assetMetrics(asset(), NOW);
    // 14,000,000 − 10,800,000 (cost basis includes stamp duty)
    expect(m.unrealisedGain).toBe(3_200_000);
    expect(m.unrealisedGainPercent).toBeCloseTo(29.63, 1);
  });

  it('quotes yield on the cost basis', () => {
    const m = assetMetrics(asset(), NOW);
    expect(m.grossYieldPercent).toBeCloseTo(3.89, 2);
    expect(m.netYieldPercent).toBeCloseTo(3.0, 1);
  });

  it('computes monthly net cash flow', () => {
    expect(assetMetrics(asset(), NOW).monthlyNetCashFlow).toBe(27_000);
  });

  it('leaves value-dependent figures undefined when the asset is unvalued', () => {
    const m = assetMetrics(asset({ currentEstimate: undefined }), NOW);
    expect(m.currentValue).toBeUndefined();
    expect(m.equity).toBeUndefined();
    expect(m.unrealisedGain).toBeUndefined();
    expect(m.annualisedReturnPercent).toBeUndefined();
    // Yield does not depend on current value, so it survives.
    expect(m.grossYieldPercent).toBeDefined();
  });

  it('flags a self-reported valuation', () => {
    expect(assetMetrics(asset({ valuationSource: 'userProvided' }), NOW).valueIsSelfReported).toBe(
      true,
    );
    expect(assetMetrics(asset({ valuationSource: 'estimated' }), NOW).valueIsSelfReported).toBe(
      false,
    );
  });
});

describe('summarisePortfolio', () => {
  it('returns a zeroed summary for an empty portfolio rather than NaN', () => {
    const s = summarisePortfolio([], NOW);
    expect(s.assetCount).toBe(0);
    expect(s.totalEquity).toBe(0);
    expect(Number.isNaN(s.selfReportedValueShare)).toBe(false);
    expect(s.unrealisedGainPercent).toBeUndefined();
  });

  it('totals cost basis, value, debt and equity', () => {
    const s = summarisePortfolio(
      [
        asset(),
        asset({
          id: 'a2',
          costBasis: 5_000_000,
          currentEstimate: 6_000_000,
          outstandingLoan: 2_000_000,
        }),
      ],
      NOW,
    );
    expect(s.totalCostBasis).toBe(15_800_000);
    expect(s.totalCurrentValue).toBe(20_000_000);
    expect(s.totalDebt).toBe(8_000_000);
    expect(s.totalEquity).toBe(12_000_000);
  });

  it('excludes unvalued assets from totals and counts them separately', () => {
    const s = summarisePortfolio(
      [asset(), asset({ id: 'a2', costBasis: 5_000_000, currentEstimate: undefined })],
      NOW,
    );
    expect(s.assetsWithoutValuation).toBe(1);
    // The unvalued asset's cost basis is not treated as its current value.
    expect(s.totalCurrentValue).toBe(14_000_000);
  });

  it('measures gain only over assets it can value', () => {
    const s = summarisePortfolio(
      [asset(), asset({ id: 'a2', costBasis: 9_000_000, currentEstimate: undefined })],
      NOW,
    );
    // Gain is 14,000,000 − 10,800,000, not diluted by the unvalued asset.
    expect(s.unrealisedGain).toBe(3_200_000);
    expect(s.unrealisedGainPercent).toBeCloseTo(29.63, 1);
  });

  it('reports what share of the portfolio value is self-reported', () => {
    const s = summarisePortfolio(
      [
        asset({ id: 'a1', currentEstimate: 10_000_000, valuationSource: 'userProvided' }),
        asset({ id: 'a2', currentEstimate: 10_000_000, valuationSource: 'estimated' }),
      ],
      NOW,
    );
    expect(s.selfReportedValueShare).toBeCloseTo(0.5, 3);
  });

  it('sums monthly net cash flow across assets', () => {
    const s = summarisePortfolio(
      [asset(), asset({ id: 'a2', monthlyRent: 20_000, monthlyExpenses: 5_000 })],
      NOW,
    );
    expect(s.totalMonthlyNetCashFlow).toBe(42_000);
  });
});
