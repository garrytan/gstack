'use client';

/**
 * Gross versus net rental yield.
 *
 * Gross yield is what gets quoted. Net yield on the full capital deployed is
 * what decides whether the flat beats a fixed deposit, and the gap between
 * the two is usually larger than people expect.
 */

import { useMemo, useState } from 'react';
import { analyseYield } from '@/domain/tools/rental-yield';
import { Input, Label } from '@/components/ui/input';
import { formatINR, formatPercent } from '@/lib/utils';

const num = (v: string): number => {
  const parsed = Number(v.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const YieldCalculator = () => {
  const [f, setF] = useState({
    purchasePrice: '10000000',
    acquisitionCosts: '800000',
    monthlyRent: '35000',
    vacancyPercent: '8',
    monthlyMaintenance: '4000',
    annualPropertyTax: '12000',
    annualInsurance: '6000',
    annualOtherCosts: '0',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));

  const r = useMemo(
    () =>
      analyseYield({
        purchasePrice: num(f.purchasePrice),
        acquisitionCosts: num(f.acquisitionCosts),
        monthlyRent: num(f.monthlyRent),
        vacancyPercent: num(f.vacancyPercent),
        monthlyMaintenance: num(f.monthlyMaintenance),
        annualPropertyTax: num(f.annualPropertyTax),
        annualInsurance: num(f.annualInsurance),
        annualOtherCosts: num(f.annualOtherCosts),
      }),
    [f],
  );

  const gap =
    r.grossYieldPercent !== undefined && r.netYieldPercent !== undefined
      ? r.grossYieldPercent - r.netYieldPercent
      : undefined;

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field
          id="price"
          label="Purchase price (₹)"
          value={f.purchasePrice}
          onChange={set('purchasePrice')}
        />
        <Field
          id="acq"
          label="Stamp duty, registration, fit-out (₹)"
          value={f.acquisitionCosts}
          onChange={set('acquisitionCosts')}
        />
        <Field
          id="rent"
          label="Monthly rent (₹)"
          value={f.monthlyRent}
          onChange={set('monthlyRent')}
        />
        <Field
          id="vac"
          label="Vacancy (%)"
          value={f.vacancyPercent}
          onChange={set('vacancyPercent')}
        />
        <Field
          id="maint"
          label="Monthly maintenance (₹)"
          value={f.monthlyMaintenance}
          onChange={set('monthlyMaintenance')}
        />
        <Field
          id="tax"
          label="Annual property tax (₹)"
          value={f.annualPropertyTax}
          onChange={set('annualPropertyTax')}
        />
        <Field
          id="ins"
          label="Annual insurance (₹)"
          value={f.annualInsurance}
          onChange={set('annualInsurance')}
        />
        <Field
          id="other"
          label="Other annual costs (₹)"
          value={f.annualOtherCosts}
          onChange={set('annualOtherCosts')}
        />
      </div>

      <dl className="mt-6 grid gap-4 rounded-lg propiq-card p-5 sm:grid-cols-4">
        <Figure
          label="Gross yield"
          value={r.grossYieldPercent === undefined ? '—' : formatPercent(r.grossYieldPercent, 2)}
          note="the quoted number"
        />
        <Figure
          label="Net yield"
          value={r.netYieldPercent === undefined ? '—' : formatPercent(r.netYieldPercent, 2)}
          note="on all capital deployed"
          lead
        />
        <Figure
          label="Net income"
          value={r.netAnnualIncome === undefined ? '—' : formatINR(r.netAnnualIncome)}
          note="per year, after costs"
        />
        <Figure
          label="Capital deployed"
          value={r.capitalDeployed === undefined ? '—' : formatINR(r.capitalDeployed)}
          note="price plus costs"
        />
      </dl>

      {gap !== undefined && (
        <p className="mt-4 rounded-lg border-l-4 border-[var(--color-negotiate)] bg-[var(--surface-1)] px-4 py-3 text-sm">
          <strong className="font-semibold">
            {formatPercent(gap, 2)} of yield disappears between the quoted figure and yours.
          </strong>{' '}
          {r.costRatio !== undefined && (
            <>
              {formatPercent(r.costRatio * 100, 0)} of the rent never reaches you, and the
              denominator is the {formatINR(r.capitalDeployed ?? 0)} you actually deployed, not the{' '}
              {formatINR(num(f.purchasePrice))} the seller was paid.
            </>
          )}
        </p>
      )}

      <dl className="mt-5 grid gap-4 sm:grid-cols-3">
        <Small
          label="Rent after vacancy"
          value={r.effectiveAnnualRent === undefined ? '—' : formatINR(r.effectiveAnnualRent)}
        />
        <Small label="Annual running costs" value={formatINR(r.annualOperatingCost)} />
        <Small
          label="Years to return the capital"
          value={r.paybackYears === undefined ? 'never at this income' : r.paybackYears.toFixed(1)}
        />
      </dl>

      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Ignores appreciation, tax on rental income and any loan, all of which change the answer. A
        dash means we will not compute a figure from a number you have not given us. Nothing you
        type is sent anywhere or stored.
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
  note,
  lead = false,
}: {
  label: string;
  value: string;
  note: string;
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
    <p className="text-[11px] text-[var(--text-muted)]">{note}</p>
  </div>
);

const Small = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg border border-[var(--border-subtle)] p-3">
    <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {label}
    </dt>
    <dd data-figure className="mt-0.5 text-sm font-semibold">
      {value}
    </dd>
  </div>
);
