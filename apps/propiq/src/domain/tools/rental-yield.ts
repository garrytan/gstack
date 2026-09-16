/**
 * Rental yield.
 *
 * Gross yield is the number every broker quotes and it flatters the asset:
 * it ignores vacancy, maintenance, tax and the cost of acquiring the thing in
 * the first place. Net yield on the full capital deployed is the number that
 * decides whether the flat beats a fixed deposit.
 *
 * Arithmetic over figures the user supplies, so it is correct for any
 * property in any market and depends on no dataset of ours. Every output is
 * `undefined` when its inputs cannot support it, never a plausible zero.
 */

export interface YieldInputs {
  readonly purchasePrice: number;
  /** Stamp duty, registration, brokerage, fit-out. Capital, not expense. */
  readonly acquisitionCosts: number;
  readonly monthlyRent: number;
  /** Share of the year the unit is empty or between tenants. */
  readonly vacancyPercent: number;
  readonly monthlyMaintenance: number;
  readonly annualPropertyTax: number;
  readonly annualInsurance: number;
  readonly annualOtherCosts: number;
}

export interface YieldResult {
  /** What the asset actually cost, not what the seller was paid. */
  readonly capitalDeployed: number | undefined;
  readonly grossAnnualRent: number | undefined;
  /** Rent after the vacancy assumption. */
  readonly effectiveAnnualRent: number | undefined;
  readonly annualOperatingCost: number;
  readonly netAnnualIncome: number | undefined;
  /** The broker's number: rent over price, nothing deducted. */
  readonly grossYieldPercent: number | undefined;
  /** Net income over everything you put in. The one that decides it. */
  readonly netYieldPercent: number | undefined;
  /** How much of the rent is eaten before it reaches you, as a share. */
  readonly costRatio: number | undefined;
  /** Years for net income to return the capital, ignoring appreciation. */
  readonly paybackYears: number | undefined;
}

export const analyseYield = (input: YieldInputs): YieldResult => {
  const {
    purchasePrice,
    acquisitionCosts,
    monthlyRent,
    vacancyPercent,
    monthlyMaintenance,
    annualPropertyTax,
    annualInsurance,
    annualOtherCosts,
  } = input;

  const capitalDeployed =
    purchasePrice > 0 ? purchasePrice + Math.max(0, acquisitionCosts) : undefined;

  const grossAnnualRent = monthlyRent > 0 ? monthlyRent * 12 : undefined;
  const vacancy = Math.min(Math.max(vacancyPercent, 0), 100);
  const effectiveAnnualRent =
    grossAnnualRent === undefined ? undefined : grossAnnualRent * (1 - vacancy / 100);

  const annualOperatingCost =
    Math.max(0, monthlyMaintenance) * 12 +
    Math.max(0, annualPropertyTax) +
    Math.max(0, annualInsurance) +
    Math.max(0, annualOtherCosts);

  const netAnnualIncome =
    effectiveAnnualRent === undefined ? undefined : effectiveAnnualRent - annualOperatingCost;

  const grossYieldPercent =
    grossAnnualRent === undefined || purchasePrice <= 0
      ? undefined
      : (grossAnnualRent / purchasePrice) * 100;

  const netYieldPercent =
    netAnnualIncome === undefined || capitalDeployed === undefined || capitalDeployed <= 0
      ? undefined
      : (netAnnualIncome / capitalDeployed) * 100;

  return {
    capitalDeployed,
    grossAnnualRent,
    effectiveAnnualRent,
    annualOperatingCost,
    netAnnualIncome,
    grossYieldPercent,
    netYieldPercent,
    costRatio:
      grossAnnualRent === undefined || grossAnnualRent <= 0
        ? undefined
        : (grossAnnualRent - (netAnnualIncome ?? 0)) / grossAnnualRent,
    // A negative or zero net income never pays the capital back, and saying
    // "never" is more use than a large positive number.
    paybackYears:
      netAnnualIncome === undefined || netAnnualIncome <= 0 || capitalDeployed === undefined
        ? undefined
        : capitalDeployed / netAnnualIncome,
  };
};
