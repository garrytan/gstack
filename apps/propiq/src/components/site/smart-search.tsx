'use client';

/**
 * Smart search.
 *
 * A real form that navigates to `/search` with the filters applied, not a
 * decorative one. Every control maps to a query parameter the search page
 * already parses, so the promise the homepage makes is one the next page
 * keeps.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { track } from '@/lib/analytics';

/**
 * Fallback shortcuts, used only when the caller passes none. A hardcoded list
 * claims coverage, so the homepage passes the localities actually in the
 * dataset and passes an empty list when there is no dataset at all.
 */
const LOCALITY_SHORTCUTS = [
  'Whitefield',
  'Sarjapur Road',
  'Hebbal',
  'Yelahanka',
  'Electronic City',
] as const;

const BUDGETS = [
  { label: 'Any budget', max: '' },
  { label: 'Under ₹1 Cr', max: '10000000' },
  { label: 'Under ₹1.5 Cr', max: '15000000' },
  { label: 'Under ₹2 Cr', max: '20000000' },
  { label: 'Under ₹3 Cr', max: '30000000' },
] as const;

export const SmartSearch = ({ localities }: { localities?: readonly string[] } = {}) => {
  const shortcuts = localities ?? LOCALITY_SHORTCUTS;
  const router = useRouter();
  const [q, setQ] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [beds, setBeds] = useState('');
  const [persona, setPersona] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (priceMax) params.set('priceMax', priceMax);
    if (beds) params.set('beds', beds);
    if (persona) params.set('persona', persona);
    track('search_submitted', { query: q.trim(), length: q.trim().length });
    router.push(params.size > 0 ? `/search?${params.toString()}` : '/search');
  };

  return (
    <div className="relative z-20 mx-auto -mt-12 max-w-6xl px-4 lg:-mt-16">
      <form
        onSubmit={submit}
        role="search"
        aria-label="Find properties"
        className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-4 shadow-[0_24px_60px_-28px_rgba(13,21,36,0.35)] sm:p-5"
      >
        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Field label="City or locality" htmlFor="ss-q">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]"
              />
              <input
                id="ss-q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Try “Whitefield 3 BHK”"
                className="h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] pl-9 pr-3 text-sm"
              />
            </div>
          </Field>

          <Field label="Budget" htmlFor="ss-budget">
            <select
              id="ss-budget"
              value={priceMax}
              onChange={(e) => setPriceMax(e.target.value)}
              className="h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 text-sm"
            >
              {BUDGETS.map((b) => (
                <option key={b.label} value={b.max}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Bedrooms" htmlFor="ss-bhk">
            <select
              id="ss-bhk"
              value={beds}
              onChange={(e) => setBeds(e.target.value)}
              className="h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 text-sm"
            >
              <option value="">Any</option>
              <option value="2">2 BHK</option>
              <option value="3">3 BHK</option>
              <option value="4">4 BHK</option>
            </select>
          </Field>

          <Field label="Intent" htmlFor="ss-intent">
            <select
              id="ss-intent"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              className="h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 text-sm"
            >
              <option value="">Either</option>
              <option value="homebuyer">Self-use</option>
              <option value="investor">Investment</option>
            </select>
          </Field>

          <div className="flex items-end">
            <button
              type="submit"
              className="propiq-brand-gradient h-11 w-full rounded-lg px-6 text-sm font-semibold text-white transition-opacity hover:opacity-90 lg:w-auto"
            >
              Find smart matches
            </button>
          </div>
        </div>

        {shortcuts.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-4">
            <span className="text-xs text-[var(--text-muted)]">Covered</span>
            {shortcuts.map((name) => (
              <Link
                key={name}
                href={`/search?q=${encodeURIComponent(name)}`}
                className="rounded-full border border-[var(--border-subtle)] px-3 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--color-brand-blue-500)] hover:text-[var(--text-primary)]"
              >
                {name}
              </Link>
            ))}
          </div>
        )}
      </form>
    </div>
  );
};

const Field = ({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) => (
  <div>
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]"
    >
      {label}
    </label>
    {children}
  </div>
);
