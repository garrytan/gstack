'use client';

/**
 * Carpet-area comparator.
 *
 * Runs entirely in the browser on numbers the buyer types. Nothing is sent
 * anywhere and nothing is stored, which is worth saying out loud on a page
 * where people paste figures off a builder's quotation.
 */

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { compareQuotes } from '@/domain/tools/area';
import type { AreaQuote } from '@/domain/tools/area';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { formatINR, formatPercent, formatPsf } from '@/lib/utils';

interface Row {
  readonly key: string;
  readonly label: string;
  readonly totalPrice: string;
  readonly superBuiltUpSqFt: string;
  readonly carpetAreaSqFt: string;
}

/** Two worked quotes, so the page opens showing what it does rather than blank. */
const INITIAL: readonly Row[] = [
  {
    key: 'a',
    label: 'Quote A',
    totalPrice: '10000000',
    superBuiltUpSqFt: '1400',
    carpetAreaSqFt: '910',
  },
  {
    key: 'b',
    label: 'Quote B',
    totalPrice: '10400000',
    superBuiltUpSqFt: '1250',
    carpetAreaSqFt: '1040',
  },
];

const num = (v: string): number => {
  const parsed = Number(v.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const CarpetCalculator = () => {
  const [rows, setRows] = useState<readonly Row[]>(INITIAL);

  const comparison = useMemo(
    () =>
      compareQuotes(
        rows.map((r): AreaQuote => ({
          label: r.label.trim() === '' ? 'Untitled' : r.label,
          totalPrice: num(r.totalPrice),
          superBuiltUpSqFt: num(r.superBuiltUpSqFt),
          carpetAreaSqFt: num(r.carpetAreaSqFt),
        })),
      ),
    [rows],
  );

  const update = (key: string, field: keyof Row, value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));

  const add = () =>
    setRows((rs) => [
      ...rs,
      {
        key: `q${Date.now()}`,
        label: `Quote ${String.fromCharCode(65 + rs.length)}`,
        totalPrice: '',
        superBuiltUpSqFt: '',
        carpetAreaSqFt: '',
      },
    ]);

  return (
    <div>
      <div className="space-y-4">
        {rows.map((row, i) => (
          <fieldset
            key={row.key}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4"
          >
            <legend className="sr-only">Quote {i + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))_auto] sm:items-end">
              <div>
                <Label htmlFor={`${row.key}-label`}>Name</Label>
                <Input
                  id={`${row.key}-label`}
                  value={row.label}
                  onChange={(e) => update(row.key, 'label', e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor={`${row.key}-price`}>All-in price (₹)</Label>
                <Input
                  id={`${row.key}-price`}
                  inputMode="numeric"
                  value={row.totalPrice}
                  onChange={(e) => update(row.key, 'totalPrice', e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor={`${row.key}-sba`}>Super built-up (sqft)</Label>
                <Input
                  id={`${row.key}-sba`}
                  inputMode="numeric"
                  value={row.superBuiltUpSqFt}
                  onChange={(e) => update(row.key, 'superBuiltUpSqFt', e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor={`${row.key}-carpet`}>Carpet (sqft)</Label>
                <Input
                  id={`${row.key}-carpet`}
                  inputMode="numeric"
                  value={row.carpetAreaSqFt}
                  onChange={(e) => update(row.key, 'carpetAreaSqFt', e.target.value)}
                  className="mt-1"
                />
              </div>
              {rows.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                  aria-label={`Remove ${row.label}`}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
          </fieldset>
        ))}
      </div>

      <Button type="button" variant="secondary" size="sm" onClick={add} className="mt-3">
        <Plus aria-hidden /> Add another quote
      </Button>

      {comparison.headlineMisleads && comparison.bestOnQuoted && comparison.bestOnCarpet && (
        <p className="mt-6 rounded-lg border-l-4 border-[var(--color-negotiate)] bg-[var(--surface-1)] px-4 py-3 text-sm">
          <strong className="font-semibold">The cheaper advertised rate is the dearer flat.</strong>{' '}
          {comparison.bestOnQuoted.label} looks cheapest at{' '}
          <span data-figure>{formatPsf(comparison.bestOnQuoted.quotedPsf ?? 0)}</span>, but you pay
          for usable floor, and on that basis {comparison.bestOnCarpet.label} is cheaper at{' '}
          <span data-figure>{formatPsf(comparison.bestOnCarpet.carpetPsf ?? 0)}</span> against{' '}
          <span data-figure>{formatPsf(comparison.bestOnQuoted.carpetPsf ?? 0)}</span>.
        </p>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="border-b border-[var(--border-subtle)] px-4 py-3 text-left text-xs text-[var(--text-muted)]">
            Advertised rate is what the brochure says. Carpet rate is what you are actually paying
            per square foot you can stand on — the only figure that compares across projects.
          </caption>
          <thead>
            <tr className="bg-[var(--surface-1)]">
              <th scope="col" className="px-4 py-2 text-left text-xs font-medium">
                Quote
              </th>
              <Th>Loading</Th>
              <Th>Carpet share</Th>
              <Th>Advertised ₹/sqft</Th>
              <Th>Carpet ₹/sqft</Th>
              <Th>Cost of the loading</Th>
            </tr>
          </thead>
          <tbody>
            {comparison.quotes.map((q) => {
              const best = comparison.bestOnCarpet?.label === q.label;
              return (
                <tr key={q.label} className="border-t border-[var(--border-subtle)]">
                  <th scope="row" className="px-4 py-2.5 text-left text-sm font-medium">
                    {q.label}
                    {best && (
                      <span className="ml-2 rounded bg-[var(--color-buy)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-buy)]">
                        Best on carpet
                      </span>
                    )}
                  </th>
                  <Td>{q.loading === undefined ? '—' : formatPercent(q.loading * 100)}</Td>
                  <Td>{q.efficiency === undefined ? '—' : formatPercent(q.efficiency * 100)}</Td>
                  <Td>{q.quotedPsf === undefined ? '—' : formatPsf(q.quotedPsf)}</Td>
                  <Td strong>{q.carpetPsf === undefined ? '—' : formatPsf(q.carpetPsf)}</Td>
                  <Td>{q.loadingCost === undefined ? '—' : formatINR(q.loadingCost)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {comparison.carpetSpread !== undefined && comparison.carpetSpread > 0 && (
        <p className="mt-3 text-xs text-[var(--text-secondary)]">
          <span data-figure>{formatPsf(comparison.carpetSpread)}</span> separates the best and worst
          carpet rate here. On a 1,000 sqft carpet flat that is{' '}
          <span data-figure>{formatINR(comparison.carpetSpread * 1000)}</span>.
        </p>
      )}

      <p className="mt-4 text-xs text-[var(--text-muted)]">
        A dash means we will not compute a figure from a number you have not given us. Nothing you
        type here is sent anywhere or stored.
      </p>
    </div>
  );
};

const Th = ({ children }: { children: React.ReactNode }) => (
  <th scope="col" className="px-4 py-2 text-right text-xs font-medium">
    {children}
  </th>
);

const Td = ({ children, strong = false }: { children: React.ReactNode; strong?: boolean }) => (
  <td
    data-figure
    className={`px-4 py-2.5 text-right text-sm ${strong ? 'font-semibold' : 'text-[var(--text-secondary)]'}`}
  >
    {children}
  </td>
);
