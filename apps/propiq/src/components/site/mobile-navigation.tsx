'use client';

/**
 * Mobile navigation.
 *
 * A slide-over rather than a dropdown, because the nav carries six
 * destinations plus two account actions and a dropdown at that length is a
 * scroll inside a scroll. Focus moves into the panel on open and returns to
 * the trigger on close; Escape and the backdrop both dismiss it.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import type { NavItem } from '@/components/site/site-header';

export const MobileNavigation = ({ items }: { items: readonly NavItem[] }) => {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    // The page behind a slide-over should not scroll under it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('a, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="site-mobile-nav"
        className="inline-flex size-10 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] lg:hidden"
      >
        <Menu aria-hidden className="size-5" />
        <span className="sr-only">Open menu</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
          />
          <div
            id="site-mobile-nav"
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label="Site navigation"
            className="absolute inset-y-0 right-0 flex w-[min(20rem,88vw)] flex-col bg-[var(--surface-0)] p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Menu
              </span>
              <button
                type="button"
                onClick={close}
                className="inline-flex size-9 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                <X aria-hidden className="size-4" />
                <span className="sr-only">Close menu</span>
              </button>
            </div>

            <nav aria-label="Main" className="mt-6 flex flex-col">
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={close}
                  className="border-b border-[var(--border-subtle)] py-3.5 text-base font-medium"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="mt-auto flex flex-col gap-2 pt-6">
              <Link
                href="/login"
                onClick={close}
                className="inline-flex h-11 items-center justify-center rounded-md border border-[var(--border-strong)] text-sm font-medium"
              >
                Login
              </Link>
              <Link
                href="/search"
                onClick={close}
                className="propiq-brand-gradient inline-flex h-11 items-center justify-center rounded-md text-sm font-semibold text-white"
              >
                Analyze Property
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
