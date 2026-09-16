'use client';

/**
 * EMI and the true cost of a home loan.
 *
 * The instalment is the number people shop on. The total interest is the
 * number that decides how much the house actually cost, and almost nobody is
 * shown it before they sign. Both are computed here, in the browser, on the
 * same reducing-balance arithmetic the investment analysis uses.
 */

import { useMemo, useState } from 'react';
import { amortisationSchedule, monthlyEmi } from '@/domain/investment/calculator';
import { Input, Label } from '@/components/ui/input';
import { formatINR, formatPercent } from '@/lib/utils';

const num = (v: string): number => {
  const parsed = Number(v.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const EmiCalculator = () => {
  const [price, setPrice] = useState('10000000');
  const [downPercent, setDownPercent] = useState('20');
  const [rate, setRate] = useState('8.6');
  const [tenure, setTenure] = useState('20');

  const result = useMemo(() => {
    const p = num(price);
    const down = Math.min(Math.max(num(downPercent), 0), 100);
    const principal = p * (1 - down / 100);
    const years = num(tenure);
    const r = num(rate);
    if (!(principal > 0) || !(years > 0)) return undefined;

    const emi = monthlyEmi(principal, r, years);
    const schedule = amortisationSchedule(principal, r, years);
    const totalInterest = schedule.at(-1)?.cumulativeInterest ?? 0;
    return {
      principal,
      downPayment: p - principal,
      emi,
      totalInterest,
      totalPaid: principal + totalInterest,
      // What you hand the bank for every rupee you borrowed.
      interestRatio: principal > 0 ? totalInterest / principal : undefined,
      schedule,
    };
  }, [price, downPercent, rate, tenure]);

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field id="price" label="Property price (₹)" value={price} onChange={setPrice} />
        <Field id="down" label="Down payment (%)" value={downPercent} onChange={setDownPercent} />
        <Field id="rate" label="Interest rate (% p.a.)" value={rate} onChange={setRate} />
        <Field id="tenure" label="Tenure (years)" value={tenure} onChange={setTenure} />
      </div>

      {result === undefined ? (
        <p className="mt-6 rounded-lg border border-dashed border-[var(--border-strong)] p-6 text-center text-sm text-[var(--text-secondary)]">
          Enter a price, a down payment below 100% and a tenure, and the instalment appears here.
        </p>
      ) : (
        <>
          <dl className="mt-6 grid gap-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-5 sm:grid-cols-4">
            <Figure label="Monthly EMI" value={formatINR(result.emi)} lead />
            <Figure label="You borrow" value={formatINR(result.principal)} />
            <Figure label="Total interest" value={formatINR(result.totalInterest)} />
            <Figure label="Total you repay" value={formatINR(result.totalPaid)} />
          </dl>

          {result.interestRatio !== undefined && (
            <p className="mt-4 rounded-lg border-l-4 border-[var(--color-negotiate)] bg-[var(--surface-1)] px-4 py-3 text-sm">
              Over {num(tenure)} years you repay{' '}
              <strong className="font-semibold">
                {formatPercent(result.interestRatio * 100, 0)}
              </strong>{' '}
              of the loan again in interest alone. A house bought with a{' '}
              {formatINR(result.principal)} loan costs {formatINR(result.totalPaid)} to finance
              before you count stamp duty, registration or maintenance.
            </p>
          )}

          <div className="mt-6 overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <caption className="border-b border-[var(--border-subtle)] px-4 py-3 text-left text-xs text-[var(--text-muted)]">
                Year by year. Early instalments are almost entirely interest, which is why prepaying
                in year three is worth many times prepaying in year fifteen.
              </caption>
              <thead>
                <tr className="bg-[var(--surface-1)]">
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium">
                    Year
                  </th>
                  <Th>Interest</Th>
                  <Th>Principal</Th>
                  <Th>Balance</Th>
                </tr>
              </thead>
              <tbody>
                {result.schedule.map((row) => (
                  <tr key={row.year} className="border-t border-[var(--border-subtle)]">
                    <th scope="row" className="px-4 py-2 text-left text-sm font-medium">
                      {row.year}
                    </th>
                    <Td>{formatINR(row.interest)}</Td>
                    <Td>{formatINR(row.principalPaid)}</Td>
                    <Td>{formatINR(row.closingBalance)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Reducing-balance arithmetic on the figures you typed. Nothing is sent anywhere or stored,
        and no lender is quoted — your sanctioned rate is the one that counts.
      </p>
    </div>
  );
};

const Field = ({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) => (
  <div>
    <Label htmlFor={id}>{label}</Label>
    <Input
      id={id}
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1"
    />
  </div>
);

const Figure = ({
  label,
  value,
  lead = false,
}: {
  label: string;
  value: string;
  lead?: boolean;
}) => (
  <div>
    <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {label}
    </dt>
    <dd
      data-figure
      className={`mt-1 font-semibold tracking-tight ${lead ? 'text-2xl text-[var(--text-accent)]' : 'text-xl'}`}
    >
      {value}
    </dd>
  </div>
);

const Th = ({ children }: { children: React.ReactNode }) => (
  <th scope="col" className="px-4 py-2 text-right text-xs font-medium">
    {children}
  </th>
);

const Td = ({ children }: { children: React.ReactNode }) => (
  <td data-figure className="px-4 py-2 text-right text-sm text-[var(--text-secondary)]">
    {children}
  </td>
);
