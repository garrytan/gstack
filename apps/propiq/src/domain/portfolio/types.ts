/**
 * Portfolio.
 *
 * A portfolio asset is something the user owns. Most of what we know about it
 * comes from them, which makes labelling the provenance of each figure more
 * important here than anywhere else in the product: a user should never be
 * unsure whether the "current value" on their own dashboard is a number they
 * typed or a number we modelled.
 */

import type { INR, Instant, PropertyId, Unit01, UserId } from '../shared/types';

/** Where a given figure on an asset came from. Rendered next to it, always. */
export const VALUATION_SOURCES = ['userProvided', 'estimated', 'verified'] as const;
export type ValuationSource = (typeof VALUATION_SOURCES)[number];

export const VALUATION_SOURCE_LABELS: Readonly<Record<ValuationSource, string>> = {
  userProvided: 'You provided this',
  estimated: 'PropIQ estimate',
  verified: 'Verified',
};

export interface PortfolioAssetInput {
  readonly label: string;
  /** Links to a tracked property when the user owns one we cover. */
  readonly propertyId?: PropertyId;
  readonly purchasePrice: INR;
  readonly purchaseDate: string; // YYYY-MM-DD
  /** Purchase price plus stamp duty, registration and any capitalised costs. */
  readonly costBasis: INR;
  readonly outstandingLoan: INR;
  readonly monthlyRent: INR;
  readonly monthlyExpenses: INR;
  readonly currentEstimate?: INR;
  readonly valuationSource: ValuationSource;
}

export interface PortfolioAsset extends PortfolioAssetInput {
  readonly id: string;
  readonly userId: UserId;
  readonly createdAt: Instant;
}

export interface AssetMetrics {
  readonly assetId: string;
  readonly label: string;
  readonly holdingYears: number;
  readonly costBasis: INR;
  /** Best available current value, and where that value came from. */
  readonly currentValue: INR | undefined;
  readonly valuationSource: ValuationSource;
  readonly equity: INR | undefined;
  readonly unrealisedGain: INR | undefined;
  readonly unrealisedGainPercent: number | undefined;
  /** Compound annual growth on the cost basis since purchase. */
  readonly annualisedReturnPercent: number | undefined;
  readonly grossYieldPercent: number | undefined;
  readonly netYieldPercent: number | undefined;
  readonly monthlyNetCashFlow: INR;
  /** True when the current value is the user's own figure rather than ours. */
  readonly valueIsSelfReported: boolean;
}

export interface PortfolioSummary {
  readonly computedAt: Instant;
  readonly assetCount: number;
  readonly totalCostBasis: INR;
  /** Sum across assets that have a current value at all. */
  readonly totalCurrentValue: INR;
  readonly totalDebt: INR;
  readonly totalEquity: INR;
  readonly totalMonthlyNetCashFlow: INR;
  readonly portfolioGrossYieldPercent: number | undefined;
  readonly unrealisedGain: INR;
  readonly unrealisedGainPercent: number | undefined;
  /** Assets with no current value at all — excluded from the totals above. */
  readonly assetsWithoutValuation: number;
  /** Share of total current value that is self-reported rather than modelled. */
  readonly selfReportedValueShare: Unit01;
  readonly assets: readonly AssetMetrics[];
}
