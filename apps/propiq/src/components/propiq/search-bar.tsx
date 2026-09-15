'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Search } from 'lucide-react';
import { track } from '@/lib/analytics';
import { Button } from '@/components/ui/button';

export const SearchBar = ({ autoFocus = false }: { autoFocus?: boolean }) => {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get('q') ?? '');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    track('search_submitted', { query: q, length: q.length });
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  };

  return (
    <form onSubmit={submit} role="search" className="flex gap-2">
      <div className="relative flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]"
        />
        <input
          type="search"
          name="q"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Search properties, projects or localities"
          placeholder="Project, locality or unit type — try “Whitefield 3 BHK”"
          className="h-11 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-0)] pl-9 pr-3 text-sm placeholder:text-[var(--text-muted)]"
        />
      </div>
      <Button type="submit" size="lg">
        Search
      </Button>
    </form>
  );
};
