'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { Locality } from '@/domain/locality/types';
import { BUYER_PERSONAS } from '@/domain/buyer/types';
import { Label, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const PRICE_STEPS = [
  { label: 'Any', value: '' },
  { label: 'Under ₹75 L', value: '7500000' },
  { label: 'Under ₹1.2 Cr', value: '12000000' },
  { label: 'Under ₹2 Cr', value: '20000000' },
  { label: 'Under ₹4 Cr', value: '40000000' },
] as const;

export const SearchFilters = ({
  localities,
  current,
}: {
  localities: readonly Locality[];
  current: { locality?: string; priceMax?: number; beds?: number; sort: string; persona: string };
}) => {
  const router = useRouter();
  const params = useSearchParams();

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page'); // a filter change always returns to page one
    router.push(`/search?${next.toString()}`);
  };

  return (
    <form className="space-y-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4">
      <fieldset className="space-y-1">
        <Label htmlFor="filter-persona">Score for</Label>
        <Select
          id="filter-persona"
          value={current.persona}
          onChange={(e) => update('persona', e.target.value)}
        >
          {BUYER_PERSONAS.map((p) => (
            <option key={p} value={p}>
              {p === 'nri' ? 'NRI buyer' : p.charAt(0).toUpperCase() + p.slice(1)}
            </option>
          ))}
        </Select>
        <p className="text-[10px] text-[var(--text-muted)]">
          Changes the pillar weights, not the underlying evidence.
        </p>
      </fieldset>

      <fieldset className="space-y-1">
        <Label htmlFor="filter-locality">Locality</Label>
        <Select
          id="filter-locality"
          value={current.locality ?? ''}
          onChange={(e) => update('locality', e.target.value)}
        >
          <option value="">All localities</option>
          {localities.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </fieldset>

      <fieldset className="space-y-1">
        <Label htmlFor="filter-price">Budget</Label>
        <Select
          id="filter-price"
          value={current.priceMax?.toString() ?? ''}
          onChange={(e) => update('priceMax', e.target.value)}
        >
          {PRICE_STEPS.map((s) => (
            <option key={s.label} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </fieldset>

      <fieldset className="space-y-1">
        <Label htmlFor="filter-beds">Bedrooms (minimum)</Label>
        <Select
          id="filter-beds"
          value={current.beds?.toString() ?? ''}
          onChange={(e) => update('beds', e.target.value)}
        >
          <option value="">Any</option>
          {[1, 2, 3, 4].map((b) => (
            <option key={b} value={b}>
              {b}+ BHK
            </option>
          ))}
        </Select>
      </fieldset>

      <fieldset className="space-y-1">
        <Label htmlFor="filter-sort">Sort by</Label>
        <Select
          id="filter-sort"
          value={current.sort}
          onChange={(e) => update('sort', e.target.value)}
        >
          <option value="scoreDesc">PropIQ Score</option>
          <option value="priceAsc">Price, low to high</option>
          <option value="priceDesc">Price, high to low</option>
          <option value="newest">Newest</option>
        </Select>
      </fieldset>

      <Button type="button" variant="ghost" size="sm" onClick={() => router.push('/search')}>
        Clear filters
      </Button>
    </form>
  );
};
