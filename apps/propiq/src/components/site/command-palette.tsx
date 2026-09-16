'use client';

/**
 * The command palette.
 *
 * Cmd/Ctrl-K. It searches the same nav model the header renders, plus whatever
 * localities the deployment actually covers, and anything it does not recognise
 * is handed to `/search` as a query rather than swallowed. Nothing in here is a
 * different destination from the ones already on the page — a palette that can
 * reach somewhere the navigation cannot is a palette that hides features.
 *
 * Dialog mechanics, in the order they matter:
 *
 *  - `role="dialog"` + `aria-modal`, labelled by its own heading.
 *  - Focus moves to the input on open and returns to whatever opened it on
 *    close. Without the return, dismissing the palette drops the user at the
 *    top of the document.
 *  - Tab is trapped inside; Escape closes.
 *  - Up/Down move the active row and the input keeps focus throughout, so the
 *    listbox is announced through `aria-activedescendant` rather than by
 *    moving focus into a list the user then has to tab out of.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CornerDownLeft, MapPin, Search } from 'lucide-react';
import { NAV_GROUPS } from '@/components/site/site-nav';
import { OPEN_PALETTE_EVENT } from '@/components/site/palette-trigger';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

interface Entry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly href: string;
  readonly hint?: string;
}

export const CommandPalette = ({
  open,
  onClose,
  localities,
}: {
  open: boolean;
  onClose: () => void;
  localities: readonly { readonly name: string; readonly slug: string }[];
}) => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [q, setQ] = useState('');
  const [rawActive, setActive] = useState(0);

  const entries = useMemo<readonly Entry[]>(
    () => [
      ...NAV_GROUPS.flatMap((g) =>
        g.columns.flatMap((c) =>
          c.links.map((l) => ({
            id: `${g.id}-${c.heading}-${l.href}-${l.label}`,
            label: l.label,
            group: g.label,
            href: l.href,
            hint: l.blurb,
          })),
        ),
      ),
      ...localities.map((l) => ({
        id: `loc-${l.slug}`,
        label: l.name,
        group: 'Localities',
        href: `/locality/${l.slug}`,
        hint: 'Location intelligence',
      })),
    ],
    [localities],
  );

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return entries.slice(0, 8);
    return entries
      .filter((e) => `${e.label} ${e.group} ${e.hint ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [entries, q]);

  // A typed query that matches nothing is still a search, not a dead end.
  const fallback = q.trim().length > 0 && results.length === 0;

  /* Clamped on read rather than reset in an effect. The active row is derived
     from the result list, and syncing derived state through useEffect means an
     extra render on every keystroke — and a frame where the highlight points
     past the end of the list. */
  const active = results.length === 0 ? 0 : Math.min(rawActive, results.length - 1);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    input.current?.focus();
    return () => {
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  const go = useCallback(
    (href: string) => {
      track('search_submitted', { query: q.trim(), length: q.trim().length });
      onClose();
      router.push(href);
    },
    [onClose, q, router],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = results[active];
      if (target) go(target.href);
      else if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`);
      return;
    }
    if (e.key === 'Tab') {
      // The palette is modal; Tab must not walk out into the page behind it.
      const focusables = panel.current?.querySelectorAll<HTMLElement>(
        'button, input, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  if (!open) return null;

  return (
    <div
      className="propiq-palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="palette-title"
        className="propiq-palette"
        onKeyDown={onKeyDown}
      >
        <h2 id="palette-title" className="sr-only">
          Search PropIQ
        </h2>

        <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3.5">
          <Search aria-hidden className="size-4 shrink-0 text-[var(--text-muted)]" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={results[active]?.id}
            aria-label="Search properties, localities and tools"
            placeholder="Search properties, localities, tools…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
          />
          <kbd className="rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
            Esc
          </kbd>
        </div>

        <ul
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="max-h-80 overflow-y-auto p-2"
        >
          {results.map((e, i) => (
            <li key={e.id} id={e.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(e.href)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                  i === active ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-1)]',
                )}
              >
                {e.group === 'Localities' ? (
                  <MapPin aria-hidden className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                ) : (
                  <ArrowRight aria-hidden className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{e.label}</span>
                  {e.hint && (
                    <span className="block truncate text-[11px] text-[var(--text-muted)]">
                      {e.hint}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {e.group}
                </span>
              </button>
            </li>
          ))}

          {fallback && (
            <li role="option" aria-selected id="palette-fallback">
              <button
                type="button"
                onClick={() => go(`/search?q=${encodeURIComponent(q.trim())}`)}
                className="flex w-full items-center gap-3 rounded-lg bg-[var(--surface-2)] px-3 py-2.5 text-left"
              >
                <Search aria-hidden className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 text-[13px]">
                  Search properties for{' '}
                  <span className="font-semibold">&ldquo;{q.trim()}&rdquo;</span>
                </span>
                <CornerDownLeft aria-hidden className="size-3.5 text-[var(--text-muted)]" />
              </button>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
};

/**
 * Owns the shortcut and the open state.
 *
 * It renders nothing but the dialog and listens for two ways in: Cmd/Ctrl-K,
 * and the event the header's trigger raises. Nothing is passed to it and it
 * passes nothing out, which is what lets the header stay a server component —
 * a callback cannot cross that boundary, but an event can.
 */
export const CommandPaletteHost = ({
  localities,
}: {
  localities: readonly { readonly name: string; readonly slug: string }[];
}) => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onRequest = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onRequest);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onRequest);
    };
  }, []);

  return <CommandPalette open={open} onClose={() => setOpen(false)} localities={localities} />;
};
