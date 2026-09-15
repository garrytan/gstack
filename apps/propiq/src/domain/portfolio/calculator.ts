/**
 * Portfolio arithmetic.
 *
 * Deterministic, like every other number in the product. The one judgement
 * call is what to do with an asset the user has not valued: it is excluded
 * from the totals and counted separately, rather than being assumed to be
 * worth its cost basis. Assuming flat value would quietly understate a gain
 * and overstate a loss, and would present an assumption as a measurement.
 */

import type { INR, Instant } from '../shared/types';
import { clamp01, round } from '../shared/types';
import { daysBetween } from '../evidence/freshness';
import type { AssetMetrics, PortfolioAsset, PortfolioSummary } from './types';

const DAYS_PER_YEAR = 365.25;

export const holdingYears = (purchaseDate: string, now: Instant): number => {
  // A bare YYYY-MM-DD is midnight UTC, which is what we want for a purchase date.
  const days = daysBetween(`${purchaseDate}T00:00:00.000Z`, now);
  return Number.isFinite(days) ? Math.max(0, days / DAYS_PER_YEAR) : 0;
};

/**
 * Compound annual growth rate on the cost basis.
 * Returns undefined below three months of holding — an annualised figure from
 * a few weeks of ownership is arithmetic noise dressed as a return.
 */
export const annualisedReturnPercent = (
  costBasis: INR,
  currentValue: INR,
  years: number,
): number | undefined => {
  if (costBasis <= 0 || currentValue <= 0 || years < 0.25) return undefined;
  return round((Math.pow(currentValue / costBasis, 1 / years) - 1) * 100, 2);
};

export const assetMetrics = (asset: PortfolioAsset, now: Instant): AssetMetrics => {
  const years = holdingYears(asset.purchaseDate, now);
  const currentValue = asset.currentEstimate;
  const annualRent = asset.monthlyRent * 12;
  const annualNet = (asset.monthlyRent - asset.monthlyExpenses) * 12;

  const equity =
    currentValue === undefined ? undefined : round(currentValue - asset.outstandingLoan, 2);
  const unrealisedGain =
    currentValue === undefined ? undefined : round(currentValue - asset.costBasis, 2);

  return {
    assetId: asset.id,
    label: asset.label,
    holdingYears: round(years, 2),
    costBasis: asset.costBasis,
    currentValue,
    valuationSource: asset.valuationSource,
    equity,
    unrealisedGain,
    unrealisedGainPercent:
      currentValue === undefined || asset.costBasis <= 0
        ? undefined
        : round(((currentValue - asset.costBasis) / asset.costBasis) * 100, 2),
    annualisedReturnPercent:
      currentValue === undefined
        ? undefined
        : annualisedReturnPercent(asset.costBasis, currentValue, years),
    // Yield is quoted on cost basis, not on current value: it answers "what is
    // this earning on what I put in", which is the question an owner asks.
    grossYieldPercent:
      asset.costBasis > 0 ? round((annualRent / asset.costBasis) * 100, 2) : undefined,
    netYieldPercent:
      asset.costBasis > 0 ? round((annualNet / asset.costBasis) * 100, 2) : undefined,
    monthlyNetCashFlow: round(asset.monthlyRent - asset.monthlyExpenses, 2),
    valueIsSelfReported: asset.valuationSource === 'userProvided',
  };
};

export const summarisePortfolio = (
  assets: readonly PortfolioAsset[],
  now: Instant,
): PortfolioSummary => {
  const metrics = assets.map((a) => assetMetrics(a, now));
  const valued = metrics.filter((m) => m.currentValue !== undefined);

  const totalCostBasis = round(
    assets.reduce((a, x) => a + x.costBasis, 0),
    2,
  );
  const totalCurrentValue = round(
    valued.reduce((a, m) => a + (m.currentValue ?? 0), 0),
    2,
  );
  const totalDebt = round(
    assets.reduce((a, x) => a + x.outstandingLoan, 0),
    2,
  );
  const totalMonthlyNetCashFlow = round(
    metrics.reduce((a, m) => a + m.monthlyNetCashFlow, 0),
    2,
  );
  const annualRent = assets.reduce((a, x) => a + x.monthlyRent * 12, 0);

  // Gain is measured only over assets we can value, so the percentage is not
  // diluted by assets whose current worth is unknown.
  const valuedCostBasis = round(
    assets.filter((a) => a.currentEstimate !== undefined).reduce((acc, a) => acc + a.costBasis, 0),
    2,
  );
  const unrealisedGain = round(totalCurrentValue - valuedCostBasis, 2);

  const selfReportedValue = valued
    .filter((m) => m.valueIsSelfReported)
    .reduce((a, m) => a + (m.currentValue ?? 0), 0);

  return {
    computedAt: now,
    assetCount: assets.length,
    totalCostBasis,
    totalCurrentValue,
    totalDebt,
    totalEquity: round(totalCurrentValue - totalDebt, 2),
    totalMonthlyNetCashFlow,
    portfolioGrossYieldPercent:
      totalCostBasis > 0 ? round((annualRent / totalCostBasis) * 100, 2) : undefined,
    unrealisedGain,
    unrealisedGainPercent:
      valuedCostBasis > 0 ? round((unrealisedGain / valuedCostBasis) * 100, 2) : undefined,
    assetsWithoutValuation: metrics.length - valued.length,
    selfReportedValueShare: clamp01(
      totalCurrentValue > 0 ? round(selfReportedValue / totalCurrentValue, 4) : 0,
    ),
    assets: metrics,
  };
};
