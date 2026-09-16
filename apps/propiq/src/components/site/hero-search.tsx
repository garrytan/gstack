'use client';

/**
 * The hero search.
 *
 * A real form. Every control maps to a query parameter `/search` already
 * parses, so the promise made here is one the next page keeps — and the
 * rotating placeholder only ever shows a phrase the search actually handles.
 * A placeholder demonstrating a capability the product does not have is a
 * fabricated claim with a cursor blinking after it.
 *
 * Intent is part of the query because it is part of the answer: the scoring
 * engine weights its twelve pillars differently for a homebuyer than for an
 * investor, so "which of these is better" has no meaning until you say who is
 * asking.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Sparkles } from 'lucide-react';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

/** Each of these resolves to a filter set `/search` understands. */
const EXAMPLES = [
  'Search Whitefield 3 BHK…',
  'Best 3 BHK under ₹1.5 Cr…',
  'Compare projects near Sarjapur Road…',
  'Low-risk shortlist in Hebbal…',
] as const;

const BUDGETS = [
  { label: 'Any budget', value: '' },
  { label: 'Under ₹1 Cr', value: '10000000' },
  { label: 'Under ₹1.5 Cr', value: '15000000' },
  { label: 'Under ₹2 Cr', value: '20000000' },
  { label: 'Under ₹3 Cr', value: '30000000' },
] as const;

const BEDS = [
  { label: 'Any size', value: '' },
  { label: '2 BHK', value: '2' },
  { label: '3 BHK', value: '3' },
  { label: '4 BHK+', value: '4' },
] as const;

const INTENTS = [
  { label: 'Buying to live in', value: 'homebuyer' },
  { label: 'Buying to invest', value: 'investor' },
  { label: 'Buying from abroad', value: 'nri' },
] as const;

const Field = ({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { readonly label: string; readonly value: string }[];
}) => {
  const id = useId();
  return (
    <div className="min-w-0 flex-1">
      <label
        htmlFor={id}
        className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]"
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full cursor-pointer truncate bg-transparent text-sm font-medium text-[var(--text-primary)] outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[var(--surface-1)]">
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
};

export const HeroSearch = ({ localities }: { localities: readonly string[] }) => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [beds, setBeds] = useState('');
  const [intent, setIntent] = useState('homebuyer');
  const [example, setExample] = useState(0);

  // The placeholder rotates only while the field is untouched and only when
  // the reader has not asked for stillness.
  useEffect(() => {
    if (q) return;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const t = setInterval(() => setExample((i) => (i + 1) % EXAMPLES.length), 3800);
    return () => clearInterval(t);
  }, [q]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    const query = q.trim();
    if (query) params.set('q', query);
    if (priceMax) params.set('priceMax', priceMax);
    if (beds) params.set('beds', beds);
    if (intent) params.set('persona', intent);
    track('search_submitted', { query, length: query.length });
    router.push(params.size > 0 ? `/search?${params.toString()}` : '/search');
  };

  return (
    <form onSubmit={submit} className="propiq-glass rounded-2xl p-2 sm:p-2.5">
      <div className="flex items-center gap-2 rounded-xl bg-[var(--surface-0)]/55 px-3 py-2.5">
        <Search aria-hidden className="size-4 shrink-0 text-[var(--text-muted)]" />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search properties, projects and localities"
          placeholder={EXAMPLES[example]}
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        {/* The visible label collapses to an icon below `sm`, so the name has
            to come from somewhere that does not: an aria-hidden icon and a
            hidden span leave the button nameless. */}
        <button
          type="submit"
          aria-label="Search properties"
          className="propiq-btn-primary inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-4 text-[13px] font-semibold text-white"
        >
          <span className="hidden sm:inline">Search</span>
          <Sparkles aria-hidden className="size-3.5 sm:hidden" />
        </button>
      </div>

      <div className="flex flex-wrap items-start gap-x-5 gap-y-3 px-3 pb-1 pt-3 sm:flex-nowrap">
        <Field label="Budget" value={priceMax} onChange={setPriceMax} options={BUDGETS} />
        <Field label="Size" value={beds} onChange={setBeds} options={BEDS} />
        <Field label="Buying for" value={intent} onChange={setIntent} options={INTENTS} />
      </div>

      {localities.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pt-1">
          <span className="text-[11px] text-[var(--text-muted)]">Try</span>
          {localities.slice(0, 4).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                setQ(name);
                input.current?.focus();
              }}
              className={cn(
                'rounded-full border border-[var(--border-subtle)] px-2.5 py-1 text-[11px]',
                'text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </form>
  );
};
