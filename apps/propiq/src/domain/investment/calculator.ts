/**
 * Deterministic property investment arithmetic.
 *
 * Conventions used throughout, chosen to match how Indian buyers actually
 * underwrite a flat:
 *  - Rent, maintenance and EMI are monthly; everything reported is annualised.
 *  - The loan is a standard reducing-balance EMI (the only structure offered
 *    on Indian home loans), amortised monthly.
 *  - Tax is applied to net rental income after the 30% standard deduction on
 *    annual value and after interest, which is how Section 24 works in practice.
 *  - Appreciation compounds on the *purchase price*, not on total acquisition
 *    cost: stamp duty is not recoverable at exit.
 */

import type { INR } from '../shared/types';
import { round } from '../shared/types';
import type {
  InvestmentAnalysis,
  InvestmentAssumptions,
  InvestmentMetrics,
  ScenarioResult,
  YearlyCashFlow,
} from './types';

/** Section 24 standard deduction on annual rental value. */
const STANDARD_DEDUCTION_RATE = 0.3;

export const DEFAULT_ASSUMPTIONS: Omit<InvestmentAssumptions, 'purchasePrice' | 'monthlyRent'> = {
  stampDutyPercent: 6.6, // Karnataka: 5% stamp + 1% registration + 0.6% cess/surcharge
  otherAcquisitionCosts: 150_000,
  downPaymentPercent: 20,
  loanInterestRatePercent: 8.6,
  loanTenureYears: 20,
  vacancyPercent: 8,
  monthlyMaintenance: 4_000,
  annualPropertyTax: 12_000,
  annualInsurance: 6_000,
  appreciationPercent: 6,
  rentEscalationPercent: 5,
  exitCostPercent: 2,
  holdingPeriodYears: 10,
  incomeTaxPercent: 30,
};

/**
 * Monthly EMI for a reducing-balance loan.
 * EMI = P·r·(1+r)^n / ((1+r)^n − 1), with r the monthly rate and n the months.
 * A zero interest rate degenerates to straight-line repayment.
 */
export const monthlyEmi = (principal: INR, annualRatePercent: number, tenureYears: number): INR => {
  if (principal <= 0 || tenureYears <= 0) return 0;
  const n = Math.round(tenureYears * 12);
  const r = annualRatePercent / 100 / 12;
  if (r === 0) return round(principal / n, 2);
  const factor = Math.pow(1 + r, n);
  return round((principal * r * factor) / (factor - 1), 2);
};

interface AmortYear {
  readonly interest: INR;
  readonly principalPaid: INR;
  readonly balanceEnd: INR;
}

/**
 * Amortise one year of a reducing-balance loan month by month.
 * Returns interest paid (tax-deductible) separately from principal (not).
 */
export const amortizeYear = (balanceStart: INR, annualRatePercent: number, emi: INR): AmortYear => {
  const r = annualRatePercent / 100 / 12;
  let balance = balanceStart;
  let interest = 0;
  let principalPaid = 0;
  for (let m = 0; m < 12 && balance > 0; m += 1) {
    const monthInterest = balance * r;
    // The final instalment is capped so the loan never overshoots into negative balance.
    const monthPrincipal = Math.min(emi - monthInterest, balance);
    interest += monthInterest;
    principalPaid += monthPrincipal;
    balance -= monthPrincipal;
  }
  return {
    interest: round(interest, 2),
    principalPaid: round(principalPaid, 2),
    balanceEnd: round(Math.max(0, balance), 2),
  };
};

export interface AmortRow {
  readonly year: number;
  readonly openingBalance: INR;
  readonly interest: INR;
  readonly principalPaid: INR;
  readonly closingBalance: INR;
  readonly cumulativeInterest: INR;
}

/**
 * Year-by-year repayment for the whole tenure.
 *
 * Built on the same `amortizeYear` step the investment analysis uses, so the
 * standalone EMI tool and the property page can never disagree about the same
 * loan. Stops early when the balance clears, which is what a prepayment or a
 * rounded final instalment produces.
 */
export const amortisationSchedule = (
  principal: INR,
  annualRatePercent: number,
  tenureYears: number,
): readonly AmortRow[] => {
  if (!(principal > 0) || !(tenureYears > 0)) return [];
  const emi = monthlyEmi(principal, annualRatePercent, tenureYears);
  const rows: AmortRow[] = [];
  let balance = principal;
  let cumulative = 0;

  for (let year = 1; year <= Math.ceil(tenureYears) && balance > 0; year += 1) {
    const step = amortizeYear(balance, annualRatePercent, emi);
    cumulative += step.interest;
    rows.push({
      year,
      openingBalance: round(balance, 2),
      interest: step.interest,
      principalPaid: step.principalPaid,
      closingBalance: step.balanceEnd,
      cumulativeInterest: round(cumulative, 2),
    });
    balance = step.balanceEnd;
  }
  return rows;
};

/**
 * IRR by bisection over [-0.99, 10].
 *
 * Bisection rather than Newton-Raphson: property cash-flow series routinely
 * have a flat or badly-conditioned derivative near the root (long runs of
 * near-zero cash flow followed by one large terminal value), where Newton
 * oscillates. Bisection is slower and always converges when the endpoints
 * bracket a sign change, which is the right trade here.
 *
 * Returns undefined when no sign change exists — e.g. a deal that never
 * returns capital. That is reported honestly rather than as a fake number.
 */
export const irr = (cashFlows: readonly number[], tolerance = 1e-7): number | undefined => {
  if (cashFlows.length < 2) return undefined;
  const npv = (rate: number): number =>
    cashFlows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);

  let low = -0.9999;
  let high = 10;
  let npvLow = npv(low);
  let npvHigh = npv(high);
  if (!Number.isFinite(npvLow) || !Number.isFinite(npvHigh)) return undefined;
  if (npvLow * npvHigh > 0) return undefined; // no bracketed root

  for (let i = 0; i < 300; i += 1) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid);
    if (Math.abs(npvMid) < tolerance || high - low < tolerance) return mid;
    if (npvLow * npvMid < 0) {
      high = mid;
      npvHigh = npvMid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }
  return (low + high) / 2;
};

export const totalAcquisitionCost = (a: InvestmentAssumptions): INR =>
  round(
    a.purchasePrice + (a.purchasePrice * a.stampDutyPercent) / 100 + a.otherAcquisitionCosts,
    2,
  );

/**
 * Build the full levered cash-flow schedule and derived metrics.
 *
 * The year-0 outflow is the down payment plus every non-financed acquisition
 * cost, because stamp duty and registration are paid from the buyer's pocket,
 * not from the loan.
 */
export const analyzeInvestment = (a: InvestmentAssumptions): InvestmentMetrics => {
  const acquisition = totalAcquisitionCost(a);
  const downPayment = round((a.purchasePrice * a.downPaymentPercent) / 100, 2);
  const loanAmount = round(a.purchasePrice - downPayment, 2);
  const emi = monthlyEmi(loanAmount, a.loanInterestRatePercent, a.loanTenureYears);
  const initialEquityOutlay = round(acquisition - loanAmount, 2);

  const schedule: YearlyCashFlow[] = [];
  let balance = loanAmount;
  let propertyValue = a.purchasePrice;
  let cumulativeCashFlow = 0;
  let breakEvenYear: number | undefined;

  for (let year = 1; year <= a.holdingPeriodYears; year += 1) {
    const rentThisYear = a.monthlyRent * Math.pow(1 + a.rentEscalationPercent / 100, year - 1);
    const grossRent = round(rentThisYear * 12, 2);
    const effectiveRent = round(grossRent * (1 - a.vacancyPercent / 100), 2);
    const operatingExpenses = round(
      a.monthlyMaintenance * 12 + a.annualPropertyTax + a.annualInsurance,
      2,
    );
    const netOperatingIncome = round(effectiveRent - operatingExpenses, 2);

    const amort = balance > 0 ? amortizeYear(balance, a.loanInterestRatePercent, emi) : null;
    const debtService = amort ? round(amort.interest + amort.principalPaid, 2) : 0;
    const interest = amort ? amort.interest : 0;
    balance = amort ? amort.balanceEnd : 0;

    const preTaxCashFlow = round(netOperatingIncome - debtService, 2);

    // Section 24 treatment: 30% standard deduction on effective annual value,
    // then interest. A negative result is a loss, which we do not tax.
    const taxableIncome = Math.max(
      0,
      effectiveRent * (1 - STANDARD_DEDUCTION_RATE) - interest - a.annualPropertyTax,
    );
    const tax = round((taxableIncome * a.incomeTaxPercent) / 100, 2);
    const afterTaxCashFlow = round(preTaxCashFlow - tax, 2);

    propertyValue = round(propertyValue * (1 + a.appreciationPercent / 100), 2);
    cumulativeCashFlow += afterTaxCashFlow;
    if (breakEvenYear === undefined && cumulativeCashFlow >= initialEquityOutlay) {
      breakEvenYear = year;
    }

    schedule.push({
      year,
      grossRent,
      effectiveRent,
      operatingExpenses,
      netOperatingIncome,
      debtService,
      preTaxCashFlow,
      tax,
      afterTaxCashFlow,
      loanBalanceEnd: balance,
      propertyValueEnd: propertyValue,
      equityEnd: round(propertyValue - balance, 2),
    });
  }

  const finalValue = propertyValue;
  const exitCost = round((finalValue * a.exitCostPercent) / 100, 2);
  const netSaleProceeds = round(finalValue - exitCost - balance, 2);
  const endingEquity = round(finalValue - balance, 2);

  // Levered IRR: year 0 is the equity cheque, later years are after-tax cash
  // flow, and the final year also receives net sale proceeds.
  const flows: number[] = [-initialEquityOutlay];
  schedule.forEach((y, idx) => {
    const isLast = idx === schedule.length - 1;
    flows.push(y.afterTaxCashFlow + (isLast ? netSaleProceeds : 0));
  });
  const irrRate = irr(flows);

  const totalCashReturned =
    schedule.reduce((sum, y) => sum + y.afterTaxCashFlow, 0) + netSaleProceeds;
  const totalRoiPercent =
    initialEquityOutlay > 0
      ? round(((totalCashReturned - initialEquityOutlay) / initialEquityOutlay) * 100, 2)
      : 0;

  const annualGrossRent = a.monthlyRent * 12;
  const year1 = schedule[0];
  const grossYieldPercent =
    a.purchasePrice > 0 ? round((annualGrossRent / a.purchasePrice) * 100, 2) : 0;
  const netYieldPercent =
    acquisition > 0 && year1 ? round((year1.netOperatingIncome / acquisition) * 100, 2) : 0;

  return {
    assumptions: a,
    totalAcquisitionCost: acquisition,
    downPayment,
    loanAmount,
    monthlyEmi: emi,
    initialEquityOutlay,
    grossYieldPercent,
    netYieldPercent,
    year1CashFlow: year1?.afterTaxCashFlow ?? 0,
    cashOnCashPercent:
      initialEquityOutlay > 0 && year1
        ? round((year1.afterTaxCashFlow / initialEquityOutlay) * 100, 2)
        : 0,
    irrPercent: irrRate === undefined ? undefined : round(irrRate * 100, 2),
    totalRoiPercent,
    breakEvenYear,
    endingEquity,
    netSaleProceeds,
    schedule,
  };
};

/**
 * Bear / base / bull on appreciation only.
 *
 * We deliberately vary one driver rather than a basket: a buyer can reason
 * about "what if prices grow 3% instead of 6%", but a multi-variable scenario
 * is a black box wearing a label.
 */
export const runScenarios = (a: InvestmentAssumptions): ScenarioResult[] => {
  const variants: ReadonlyArray<{ name: ScenarioResult['name']; label: string; delta: number }> = [
    { name: 'bear', label: 'Bear — appreciation 3 points below base', delta: -3 },
    { name: 'base', label: 'Base — stated appreciation assumption', delta: 0 },
    { name: 'bull', label: 'Bull — appreciation 3 points above base', delta: 3 },
  ];
  return variants.map((v) => {
    const metrics = analyzeInvestment({
      ...a,
      appreciationPercent: a.appreciationPercent + v.delta,
    });
    return {
      name: v.name,
      label: v.label,
      appreciationPercent: a.appreciationPercent + v.delta,
      irrPercent: metrics.irrPercent,
      totalRoiPercent: metrics.totalRoiPercent,
      endingEquity: metrics.endingEquity,
    };
  });
};

export const analyzeWithScenarios = (
  a: InvestmentAssumptions,
  inputConfidence: number,
  caveats: readonly string[] = [],
): InvestmentAnalysis => ({
  base: analyzeInvestment(a),
  scenarios: runScenarios(a),
  inputConfidence,
  caveats: [
    'Projections are arithmetic on the assumptions shown, not a forecast. Change an ' +
      'assumption and the output changes with it.',
    'Tax treatment is a simplified Section 24 model. It is not tax advice.',
    ...caveats,
  ],
});
