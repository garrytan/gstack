import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSUMPTIONS,
  amortizeYear,
  analyzeInvestment,
  irr,
  monthlyEmi,
  runScenarios,
  totalAcquisitionCost,
} from '@/domain/investment/calculator';
import type { InvestmentAssumptions } from '@/domain/investment/types';

const assumptions = (overrides: Partial<InvestmentAssumptions> = {}): InvestmentAssumptions => ({
  ...DEFAULT_ASSUMPTIONS,
  purchasePrice: 10_000_000,
  monthlyRent: 30_000,
  ...overrides,
});

describe('monthlyEmi', () => {
  it('matches the standard reducing-balance formula', () => {
    // ₹80L at 8.6% over 20 years. Cross-checked against the closed-form EMI.
    const emi = monthlyEmi(8_000_000, 8.6, 20);
    expect(emi).toBeGreaterThan(69_000);
    expect(emi).toBeLessThan(70_500);
  });

  it('degenerates to straight-line repayment at zero interest', () => {
    expect(monthlyEmi(1_200_000, 0, 10)).toBeCloseTo(10_000, 2);
  });

  it('returns zero for a zero principal or zero tenure', () => {
    expect(monthlyEmi(0, 8, 20)).toBe(0);
    expect(monthlyEmi(1_000_000, 8, 0)).toBe(0);
  });
});

describe('amortizeYear', () => {
  it('splits an instalment into interest and principal and reduces the balance', () => {
    const emi = monthlyEmi(1_000_000, 12, 10);
    const year = amortizeYear(1_000_000, 12, emi);
    expect(year.interest).toBeGreaterThan(0);
    expect(year.principalPaid).toBeGreaterThan(0);
    expect(year.balanceEnd).toBeLessThan(1_000_000);
    expect(year.balanceEnd).toBeCloseTo(1_000_000 - year.principalPaid, 1);
  });

  it('never drives the balance below zero on the final instalment', () => {
    const emi = monthlyEmi(100_000, 10, 1);
    const year = amortizeYear(100_000, 10, emi);
    expect(year.balanceEnd).toBe(0);
    expect(year.principalPaid).toBeLessThanOrEqual(100_000 + 0.01);
  });

  it('fully amortises the loan over its stated tenure', () => {
    const principal = 5_000_000;
    const emi = monthlyEmi(principal, 9, 15);
    let balance = principal;
    for (let y = 0; y < 15; y += 1) balance = amortizeYear(balance, 9, emi).balanceEnd;
    expect(balance).toBeLessThan(1); // closes out to zero, bar rounding
  });
});

describe('irr', () => {
  it('recovers a known rate', () => {
    // -1000 now, +1100 in one year is exactly 10%.
    expect(irr([-1000, 1100])).toBeCloseTo(0.1, 5);
  });

  it('solves a multi-period series', () => {
    const rate = irr([-10_000, 3_000, 3_000, 3_000, 3_000]);
    expect(rate).toBeDefined();
    expect(rate as number).toBeCloseTo(0.0771, 3);
  });

  it('returns undefined when no sign change brackets a root', () => {
    expect(irr([-1000, -500, -200])).toBeUndefined();
  });

  it('returns undefined for a degenerate series', () => {
    expect(irr([-1000])).toBeUndefined();
  });
});

describe('totalAcquisitionCost', () => {
  it('adds stamp duty and other costs to the purchase price', () => {
    const cost = totalAcquisitionCost(
      assumptions({
        purchasePrice: 10_000_000,
        stampDutyPercent: 6.6,
        otherAcquisitionCosts: 150_000,
      }),
    );
    expect(cost).toBe(10_810_000);
  });
});

describe('analyzeInvestment', () => {
  it('computes gross yield from annual rent over purchase price', () => {
    const m = analyzeInvestment(assumptions({ purchasePrice: 10_000_000, monthlyRent: 30_000 }));
    expect(m.grossYieldPercent).toBeCloseTo(3.6, 2);
  });

  it('builds a schedule of the requested length', () => {
    const m = analyzeInvestment(assumptions({ holdingPeriodYears: 7 }));
    expect(m.schedule).toHaveLength(7);
    expect(m.schedule.at(-1)?.year).toBe(7);
  });

  it('escalates rent year on year', () => {
    const m = analyzeInvestment(assumptions({ rentEscalationPercent: 5 }));
    const y1 = m.schedule[0]!.grossRent;
    const y2 = m.schedule[1]!.grossRent;
    expect(y2 / y1).toBeCloseTo(1.05, 3);
  });

  it('appreciates property value at the stated rate', () => {
    const m = analyzeInvestment(
      assumptions({ purchasePrice: 10_000_000, appreciationPercent: 6, holdingPeriodYears: 2 }),
    );
    expect(m.schedule[0]!.propertyValueEnd).toBeCloseTo(10_600_000, 0);
    expect(m.schedule[1]!.propertyValueEnd).toBeCloseTo(11_236_000, 0);
  });

  it('pays down the loan so equity rises over the hold', () => {
    const m = analyzeInvestment(assumptions({ holdingPeriodYears: 10 }));
    const first = m.schedule[0]!.equityEnd;
    const last = m.schedule.at(-1)!.equityEnd;
    expect(last).toBeGreaterThan(first);
    expect(m.schedule.at(-1)!.loanBalanceEnd).toBeLessThan(m.loanAmount);
  });

  it('charges the equity cheque, not the loan, for stamp duty', () => {
    const m = analyzeInvestment(
      assumptions({ purchasePrice: 10_000_000, downPaymentPercent: 20, stampDutyPercent: 6.6 }),
    );
    expect(m.downPayment).toBe(2_000_000);
    expect(m.loanAmount).toBe(8_000_000);
    // 2,000,000 down + 660,000 stamp duty + 150,000 other
    expect(m.initialEquityOutlay).toBe(2_810_000);
  });

  it('produces a higher IRR when appreciation is higher', () => {
    const low = analyzeInvestment(assumptions({ appreciationPercent: 3 }));
    const high = analyzeInvestment(assumptions({ appreciationPercent: 9 }));
    expect(high.irrPercent).toBeDefined();
    expect(low.irrPercent).toBeDefined();
    expect(high.irrPercent as number).toBeGreaterThan(low.irrPercent as number);
  });

  it('taxes rental income only after the Section 24 standard deduction and interest', () => {
    // A heavily levered year has large interest, so taxable income should be zero.
    const m = analyzeInvestment(
      assumptions({ downPaymentPercent: 10, loanInterestRatePercent: 12, monthlyRent: 20_000 }),
    );
    expect(m.schedule[0]!.tax).toBe(0);
  });

  it('taxes an unlevered high-rent year', () => {
    const m = analyzeInvestment(
      assumptions({ downPaymentPercent: 100, monthlyRent: 100_000, annualPropertyTax: 12_000 }),
    );
    expect(m.schedule[0]!.tax).toBeGreaterThan(0);
  });

  it('handles an all-cash purchase with no debt service', () => {
    const m = analyzeInvestment(assumptions({ downPaymentPercent: 100 }));
    expect(m.loanAmount).toBe(0);
    expect(m.monthlyEmi).toBe(0);
    expect(m.schedule[0]!.debtService).toBe(0);
  });

  it('nets exit costs and outstanding debt out of sale proceeds', () => {
    const m = analyzeInvestment(assumptions({ holdingPeriodYears: 5, exitCostPercent: 2 }));
    const finalValue = m.schedule.at(-1)!.propertyValueEnd;
    const balance = m.schedule.at(-1)!.loanBalanceEnd;
    expect(m.netSaleProceeds).toBeCloseTo(finalValue - finalValue * 0.02 - balance, 0);
  });
});

describe('runScenarios', () => {
  it('orders bear below base below bull on IRR', () => {
    const [bear, base, bull] = runScenarios(assumptions());
    expect(bear!.irrPercent as number).toBeLessThan(base!.irrPercent as number);
    expect(base!.irrPercent as number).toBeLessThan(bull!.irrPercent as number);
  });

  it('varies only the appreciation assumption', () => {
    const scenarios = runScenarios(assumptions({ appreciationPercent: 6 }));
    expect(scenarios.map((s) => s.appreciationPercent)).toEqual([3, 6, 9]);
  });
});
