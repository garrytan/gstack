'use client';

/**
 * The mega menu.
 *
 * A client island inside a server-rendered header, not a client header. The
 * distinction is load-bearing: `BrandMark` checks the brand files with
 * `existsSync` at render, so marking the whole header `'use client'` pulled
 * `node:fs` into the browser graph and Turbopack refused to build it. Only the
 * disclosure behaviour needs to run in the browser, so only the disclosure
 * behaviour ships.
 *
 * The behaviour, in the order it matters:
 *
 *  - Pointer opens on hover, because a menu that needs a click to browse is a
 *    menu people stop browsing. Keyboard opens on Enter or Space, never on
 *    focus — focus-to-open makes tabbing past the bar impossible.
 *  - The trigger is a real `button` with `aria-expanded`; the panel is
 *    labelled by it.
 *  - Escape closes and returns focus to the trigger. Tabbing out of the panel
 *    closes it. Both matter more than the hover does.
 *  - Closing is delayed ~120ms so the diagonal move from trigger to panel does
 *    not drop the menu halfway.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { NAV_GROUPS } from '@/components/site/site-nav';
import { cn } from '@/lib/utils';

export const MegaMenuNav = () => {
  const [open, setOpen] = useState<string | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bar = useRef<HTMLElement>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(undefined), 120);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    if (open === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(undefined);
      bar.current?.querySelector<HTMLButtonElement>(`[data-trigger="${open}"]`)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <nav
      ref={bar}
      aria-label="Main"
      className="hidden items-center gap-1 lg:flex"
      onMouseLeave={scheduleClose}
    >
      {NAV_GROUPS.map((group) => (
        <div
          key={group.id}
          className="relative"
          onMouseEnter={() => {
            cancelClose();
            setOpen(group.id);
          }}
        >
          <button
            type="button"
            data-trigger={group.id}
            aria-expanded={open === group.id}
            aria-controls={`nav-${group.id}`}
            onClick={() => setOpen((v) => (v === group.id ? undefined : group.id))}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              open === group.id
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {group.label}
            <ChevronDown
              aria-hidden
              className={cn('size-3.5 transition-transform', open === group.id && 'rotate-180')}
            />
          </button>

          {open === group.id && (
            <div
              id={`nav-${group.id}`}
              aria-label={group.label}
              className="propiq-megamenu"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(undefined);
              }}
            >
              <div
                className={cn(
                  'grid gap-x-8 gap-y-6 p-6',
                  group.feature
                    ? 'grid-cols-[repeat(2,minmax(11rem,1fr))_minmax(15rem,1fr)]'
                    : 'grid-cols-[repeat(2,minmax(12rem,1fr))]',
                )}
              >
                {group.columns.map((col) => (
                  <div key={col.heading}>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                      {col.heading}
                    </p>
                    <ul className="mt-3 space-y-0.5">
                      {col.links.map((link) => (
                        <li key={`${col.heading}-${link.href}-${link.label}`}>
                          <Link
                            href={link.href}
                            onClick={() => setOpen(undefined)}
                            className="propiq-block-link block rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--surface-1)]"
                          >
                            <span className="block text-[13px] font-medium">{link.label}</span>
                            {link.blurb && (
                              <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--text-muted)]">
                                {link.blurb}
                              </span>
                            )}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {group.feature && (
                  <Link
                    href={group.feature.href}
                    onClick={() => setOpen(undefined)}
                    className="propiq-block-link propiq-megamenu-feature flex flex-col justify-end rounded-xl p-5"
                  >
                    <span className="text-[13px] font-semibold">{group.feature.title}</span>
                    <span className="mt-1.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">
                      {group.feature.body}
                    </span>
                    <span className="mt-3 inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-accent)]">
                      Open <ArrowRight aria-hidden className="size-3" />
                    </span>
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </nav>
  );
};
