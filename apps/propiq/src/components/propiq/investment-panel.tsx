/**
 * Investment outlook.
 *
 * Shows the assumptions as prominently as the outputs. An IRR without its
 * assumptions is a number someone can be misled by; with them it is a model
 * the buyer can argue with, which is the point.
 */

import type { InvestmentAnalysis } from '@/domain/investment/types';
import { formatINR, formatPercent } from '@/lib/utils';

export const InvestmentPanel = ({ analysis }: { analysis: InvestmentAnalysis }) => {
  const { base, scenarios, caveats, inputConfidence } = analysis;
  const noRent = base.assumptions.monthlyRent <= 0;

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4">
      {noRent ? (
        <p className="text-sm text-[var(--text-secondary)]">
          We have no rent estimate for this unit, so yield, cash flow and IRR would be arithmetic on
          a number we made up. They are not shown.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Gross yield" value={formatPercent(base.grossYieldPercent, 2)} />
            <Stat label="Net yield" value={formatPercent(base.netYieldPercent, 2)} />
            <Stat label="Monthly EMI" value={formatINR(base.monthlyEmi)} />
            <Stat label="Year 1 cash flow" value={formatINR(base.year1CashFlow)} />
            <Stat
              label="Levered IRR"
              value={base.irrPercent === undefined ? 'n/a' : formatPercent(base.irrPercent, 2)}
            />
            <Stat
              label="Break-even"
              value={
                base.breakEvenYear
                  ? `Year ${base.breakEvenYear}`
                  : `beyond year ${base.assumptions.holdingPeriodYears}`
              }
            />
          </dl>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <caption className="sr-only">
                Return scenarios by appreciation assumption over a{' '}
                {base.assumptions.holdingPeriodYears}-year hold
              </caption>
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-left text-[var(--text-muted)]">
                  <th scope="col" className="py-1.5 font-normal">
                    Scenario
                  </th>
                  <th scope="col" className="py-1.5 text-right font-normal">
                    Appreciation
                  </th>
                  <th scope="col" className="py-1.5 text-right font-normal">
                    IRR
                  </th>
                  <th scope="col" className="py-1.5 text-right font-normal">
                    Total ROI
                  </th>
                  <th scope="col" className="py-1.5 text-right font-normal">
                    Ending equity
                  </th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s) => (
                  <tr key={s.name} className="border-b border-[var(--border-subtle)] last:border-0">
                    <th scope="row" className="py-1.5 text-left font-medium capitalize">
                      {s.name}
                    </th>
                    <td data-figure className="py-1.5 text-right">
                      {formatPercent(s.appreciationPercent)}
                    </td>
                    <td data-figure className="py-1.5 text-right">
                      {s.irrPercent === undefined ? 'n/a' : formatPercent(s.irrPercent, 2)}
                    </td>
                    <td data-figure className="py-1.5 text-right">
                      {formatPercent(s.totalRoiPercent)}
                    </td>
                    <td data-figure className="py-1.5 text-right">
                      {formatINR(s.endingEquity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              Scenarios vary appreciation only. Over a {base.assumptions.holdingPeriodYears}-year
              hold, the bear case returns {formatPercent(scenarios[0]?.totalRoiPercent ?? 0)} total
              against {formatPercent(scenarios[2]?.totalRoiPercent ?? 0)} in the bull case.
            </p>
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-semibold">
              The assumptions behind these numbers
            </summary>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Purchase price" value={formatINR(base.assumptions.purchasePrice)} />
              <Stat
                label="Stamp duty + reg."
                value={formatPercent(base.assumptions.stampDutyPercent)}
              />
              <Stat
                label="Down payment"
                value={formatPercent(base.assumptions.downPaymentPercent)}
              />
              <Stat
                label="Loan rate"
                value={formatPercent(base.assumptions.loanInterestRatePercent, 2)}
              />
              <Stat label="Tenure" value={`${base.assumptions.loanTenureYears} years`} />
              <Stat label="Monthly rent" value={formatINR(base.assumptions.monthlyRent)} />
              <Stat label="Vacancy" value={formatPercent(base.assumptions.vacancyPercent)} />
              <Stat
                label="Rent escalation"
                value={formatPercent(base.assumptions.rentEscalationPercent)}
              />
              <Stat
                label="Appreciation"
                value={formatPercent(base.assumptions.appreciationPercent)}
              />
              <Stat label="Exit cost" value={formatPercent(base.assumptions.exitCostPercent)} />
              <Stat label="Holding period" value={`${base.assumptions.holdingPeriodYears} years`} />
              <Stat label="Total acquisition" value={formatINR(base.totalAcquisitionCost)} />
            </dl>
          </details>
        </>
      )}

      <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
        <p className="text-[11px] text-[var(--text-muted)]">
          Input confidence {Math.round(inputConfidence * 100)}%. The arithmetic is exact; the
          confidence refers to the inputs it runs on.
        </p>
        <ul className="mt-1 space-y-0.5">
          {caveats.map((c) => (
            <li key={c} className="text-[11px] text-[var(--text-muted)]">
              {c}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd data-figure className="mt-0.5 text-sm font-semibold">
      {value}
    </dd>
  </div>
);
