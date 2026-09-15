/**
 * Investment analysis types.
 *
 * Every number here is produced by deterministic arithmetic in `calculator.ts`.
 * No LLM is ever asked to compute a yield, a cash flow or an IRR.
 */

import type { INR, Unit01 } from '../shared/types';

export interface InvestmentAssumptions {
  readonly purchasePrice: INR;
  /** Stamp duty + registration, as a percentage of purchase price. */
  readonly stampDutyPercent: number;
  readonly otherAcquisitionCosts: INR;
  readonly downPaymentPercent: number;
  readonly loanInterestRatePercent: number;
  readonly loanTenureYears: number;
  readonly monthlyRent: INR;
  readonly vacancyPercent: number;
  readonly monthlyMaintenance: INR;
  readonly annualPropertyTax: INR;
  readonly annualInsurance: INR;
  /** Annual capital appreciation, percent. */
  readonly appreciationPercent: number;
  /** Annual rent escalation, percent. */
  readonly rentEscalationPercent: number;
  readonly exitCostPercent: number;
  readonly holdingPeriodYears: number;
  /** Income-tax rate applied to net rental income, percent. */
  readonly incomeTaxPercent: number;
}

export interface YearlyCashFlow {
  readonly year: number;
  readonly grossRent: INR;
  readonly effectiveRent: INR;
  readonly operatingExpenses: INR;
  readonly netOperatingIncome: INR;
  readonly debtService: INR;
  readonly preTaxCashFlow: INR;
  readonly tax: INR;
  readonly afterTaxCashFlow: INR;
  readonly loanBalanceEnd: INR;
  readonly propertyValueEnd: INR;
  readonly equityEnd: INR;
}

export interface InvestmentMetrics {
  readonly assumptions: InvestmentAssumptions;
  readonly totalAcquisitionCost: INR;
  readonly downPayment: INR;
  readonly loanAmount: INR;
  readonly monthlyEmi: INR;
  readonly initialEquityOutlay: INR;
  readonly grossYieldPercent: number;
  readonly netYieldPercent: number;
  readonly year1CashFlow: INR;
  readonly cashOnCashPercent: number;
  /** Levered IRR over the holding period, percent. Undefined when it does not converge. */
  readonly irrPercent: number | undefined;
  readonly totalRoiPercent: number;
  /** Year in which cumulative after-tax cash flow turns positive; undefined if never. */
  readonly breakEvenYear: number | undefined;
  readonly endingEquity: INR;
  readonly netSaleProceeds: INR;
  readonly schedule: readonly YearlyCashFlow[];
}

export interface ScenarioResult {
  readonly name: 'bear' | 'base' | 'bull';
  readonly label: string;
  readonly appreciationPercent: number;
  readonly irrPercent: number | undefined;
  readonly totalRoiPercent: number;
  readonly endingEquity: INR;
}

export interface InvestmentAnalysis {
  readonly base: InvestmentMetrics;
  readonly scenarios: readonly ScenarioResult[];
  /** Confidence in the *inputs*, not the arithmetic. Arithmetic is exact. */
  readonly inputConfidence: Unit01;
  readonly caveats: readonly string[];
}
