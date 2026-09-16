'use client';

import { useState, useTransition } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import type { PortfolioSummary } from '@/domain/portfolio/types';
import { VALUATION_SOURCE_LABELS } from '@/domain/portfolio/types';
import { addPortfolioAsset, removePortfolioAsset } from '@/server/actions';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { formatINR, formatPercent } from '@/lib/utils';

export const PortfolioManager = ({ summary }: { summary: PortfolioSummary }) => {
  const [open, setOpen] = useState(summary.assetCount === 0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const raw = Object.fromEntries(form.entries());
    const currentEstimate = String(raw.currentEstimate ?? '').trim();

    startTransition(async () => {
      const result = await addPortfolioAsset({
        ...raw,
        currentEstimate: currentEstimate === '' ? undefined : currentEstimate,
      });
      setMessage({ ok: result.ok, text: result.message ?? '' });
      if (result.ok) setOpen(false);
    });
  };

  const remove = (assetId: string) => {
    startTransition(async () => {
      const result = await removePortfolioAsset(assetId);
      setMessage({ ok: result.ok, text: result.message ?? '' });
    });
  };

  return (
    <div className="space-y-8">
      {summary.assetCount > 0 && <Totals summary={summary} />}

      {summary.assetCount === 0 && !open && (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
          <p className="text-sm font-medium">No assets tracked yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
            Add something you own and PropIQ will track its equity, yield and return. Figures you
            supply stay labelled as yours.
          </p>
          <Button type="button" className="mt-4" onClick={() => setOpen(true)}>
            <Plus aria-hidden /> Add an asset
          </Button>
        </div>
      )}

      {summary.assets.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">Assets</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <caption className="sr-only">Portfolio assets with return metrics</caption>
              <thead>
                <tr className="border-b border-[var(--border-strong)] text-left text-xs">
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Asset
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Cost basis
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Current value
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Equity
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Gain
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Annualised
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Gross yield
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">
                    Net monthly
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.assets.map((a) => (
                  <tr key={a.assetId} className="border-b border-[var(--border-subtle)]">
                    <th scope="row" className="py-2.5 pr-4 text-left">
                      <span className="text-xs font-medium">{a.label}</span>
                      <span className="mt-1 block">
                        <Badge tone={a.valueIsSelfReported ? 'warn' : 'neutral'}>
                          {VALUATION_SOURCE_LABELS[a.valuationSource]}
                        </Badge>
                      </span>
                    </th>
                    <td data-figure className="py-2.5 pr-4 text-right text-xs">
                      {formatINR(a.costBasis)}
                    </td>
                    <td data-figure className="py-2.5 pr-4 text-right text-xs">
                      {a.currentValue === undefined ? (
                        <span className="text-[var(--text-muted)]">not valued</span>
                      ) : (
                        formatINR(a.currentValue)
                      )}
                    </td>
                    <td data-figure className="py-2.5 pr-4 text-right text-xs">
                      {a.equity === undefined ? '—' : formatINR(a.equity)}
                    </td>
                    <td
                      data-figure
                      className="py-2.5 pr-4 text-right text-xs font-medium"
                      style={
                        a.unrealisedGain === undefined
                          ? undefined
                          : {
                              color:
                                a.unrealisedGain >= 0 ? 'var(--color-buy)' : 'var(--color-avoid)',
                            }
                      }
                    >
                      {a.unrealisedGain === undefined
                        ? '—'
                        : formatPercent(a.unrealisedGainPercent)}
                    </td>
                    <td data-figure className="py-2.5 pr-4 text-right text-xs">
                      {a.annualisedReturnPercent === undefined
                        ? '—'
                        : formatPercent(a.annualisedReturnPercent, 2)}
                    </td>
                    <td data-figure className="py-2.5 pr-4 text-right text-xs">
                      {formatPercent(a.grossYieldPercent, 2)}
                    </td>
                    <td data-figure className="py-2.5 pr-4 text-right text-xs">
                      {formatINR(a.monthlyNetCashFlow)}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => remove(a.assetId)}
                        disabled={pending}
                        aria-label={`Remove ${a.label}`}
                        className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--color-avoid)]"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {summary.assetsWithoutValuation > 0 && (
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              {summary.assetsWithoutValuation} asset
              {summary.assetsWithoutValuation === 1 ? ' has' : 's have'} no current value, so{' '}
              {summary.assetsWithoutValuation === 1 ? 'it is' : 'they are'} excluded from the totals
              above. PropIQ does not assume an unvalued asset is still worth what you paid.
            </p>
          )}
        </section>
      )}

      {open ? (
        <section className="rounded-lg propiq-card p-5">
          <h2 className="text-sm font-semibold">Add an asset</h2>
          <form onSubmit={submit} className="mt-4 space-y-4">
            <div className="space-y-1">
              <Label htmlFor="label">Name</Label>
              <Input
                id="label"
                name="label"
                required
                maxLength={120}
                placeholder="e.g. Whitefield 3BHK"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="purchasePrice" label="Purchase price (₹)" type="number" required />
              <Field id="purchaseDate" label="Purchase date" type="date" required />
              <Field
                id="costBasis"
                label="Cost basis (₹)"
                type="number"
                required
                hint="Purchase price plus stamp duty, registration and capitalised costs."
              />
              <Field
                id="outstandingLoan"
                label="Outstanding loan (₹)"
                type="number"
                defaultValue="0"
                required
              />
              <Field
                id="monthlyRent"
                label="Monthly rent (₹)"
                type="number"
                defaultValue="0"
                required
              />
              <Field
                id="monthlyExpenses"
                label="Monthly expenses (₹)"
                type="number"
                defaultValue="0"
                required
                hint="Maintenance, tax, insurance — anything recurring."
              />
              <Field
                id="currentEstimate"
                label="Current value (₹)"
                type="number"
                hint="Leave blank if you do not know. We will not assume it."
              />
              <div className="space-y-1">
                <Label htmlFor="valuationSource">Where that value came from</Label>
                <Select id="valuationSource" name="valuationSource" defaultValue="userProvided">
                  <option value="userProvided">My own estimate</option>
                  <option value="estimated">A professional valuation</option>
                </Select>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Shown next to the figure everywhere it appears.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 aria-hidden className="animate-spin" />}
                Add asset
              </Button>
              {summary.assetCount > 0 && (
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </section>
      ) : (
        summary.assetCount > 0 && (
          <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
            <Plus aria-hidden /> Add another asset
          </Button>
        )
      )}

      {message && (
        <p
          role="status"
          className="text-xs"
          style={{ color: message.ok ? 'var(--color-buy)' : 'var(--color-avoid)' }}
        >
          {message.text}
        </p>
      )}
    </div>
  );
};

const Totals = ({ summary }: { summary: PortfolioSummary }) => (
  <section>
    <h2 className="text-sm font-semibold">Totals</h2>
    <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="Cost basis" value={formatINR(summary.totalCostBasis)} />
      <Stat label="Current value" value={formatINR(summary.totalCurrentValue)} />
      <Stat label="Debt" value={formatINR(summary.totalDebt)} />
      <Stat label="Equity" value={formatINR(summary.totalEquity)} />
      <Stat
        label="Unrealised gain"
        value={formatPercent(summary.unrealisedGainPercent)}
        tone={summary.unrealisedGain >= 0 ? 'good' : 'bad'}
      />
      <Stat label="Net monthly" value={formatINR(summary.totalMonthlyNetCashFlow)} />
    </dl>
    {summary.selfReportedValueShare > 0 && (
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        {Math.round(summary.selfReportedValueShare * 100)}% of the current value above is your own
        figure rather than a valuation. Returns computed from it are only as good as that number.
      </p>
    )}
  </section>
);

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) => (
  <div>
    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd
      data-figure
      className="mt-0.5 text-sm font-semibold"
      style={
        tone === 'good'
          ? { color: 'var(--color-buy)' }
          : tone === 'bad'
            ? { color: 'var(--color-avoid)' }
            : undefined
      }
    >
      {value}
    </dd>
  </div>
);

const Field = ({
  id,
  label,
  type,
  required,
  defaultValue,
  hint,
}: {
  id: string;
  label: string;
  type: string;
  required?: boolean;
  defaultValue?: string;
  hint?: string;
}) => (
  <div className="space-y-1">
    <Label htmlFor={id}>{label}</Label>
    <Input
      id={id}
      name={id}
      type={type}
      required={required}
      defaultValue={defaultValue}
      min={type === 'number' ? 0 : undefined}
    />
    {hint && <p className="text-[11px] text-[var(--text-muted)]">{hint}</p>}
  </div>
);
