'use client';

/**
 * One dock at the bottom of the page, two jobs.
 *
 * When the comparison tray has something in it, the dock is the tray. When it
 * is empty, the dock becomes the mobile call to action once the visitor has
 * scrolled past the hero. Two competing fixed bars on a phone would cost more
 * screen than either is worth, so they share the slot.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Scale, X } from 'lucide-react';
import { useShortlist } from '@/components/site/shortlist';

/** Roughly one viewport: below this the hero's own CTA is still on screen. */
const REVEAL_AFTER_PX = 680;

export const BottomDock = () => {
  const { entries, clear, toggle } = useShortlist();
  const [scrolled, setScrolled] = useState(false);
  const showing = entries.length > 0 || scrolled;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > REVEAL_AFTER_PX);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A fixed bar cannot push anything, so the page has to make room for it or
  // the last section sits underneath it for good. The flag is on <body> so the
  // padding lands on the site wrapper without the dock knowing where it is.
  useEffect(() => {
    if (!showing) return;
    document.body.dataset.dock = 'on';
    return () => {
      delete document.body.dataset.dock;
    };
  }, [showing]);

  if (entries.length > 0) {
    const href = `/compare?ids=${entries.map((e) => encodeURIComponent(e.id)).join(',')}`;
    return (
      <Dock label="Comparison tray">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Scale aria-hidden className="size-4 shrink-0 text-[var(--text-muted)]" />
          <ul className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
            {entries.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => toggle(e)}
                  className="inline-flex max-w-[11rem] items-center gap-1 rounded-full bg-[var(--surface-1)] py-1 pl-2.5 pr-1.5 text-xs whitespace-nowrap"
                >
                  <span className="truncate">{e.name}</span>
                  <X aria-hidden className="size-3 shrink-0" />
                  <span className="sr-only">Remove {e.name} from the comparison</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={clear}
            className="rounded-lg px-2 py-1.5 text-xs text-[var(--text-muted)] hover:underline"
          >
            Clear
          </button>
          <Link
            href={href}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-blue-500)] px-3 py-2 text-xs font-semibold text-white"
          >
            Compare {entries.length}
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </Dock>
    );
  }

  if (!scrolled) return null;

  return (
    <Dock label="Get started" className="lg:hidden">
      <p className="min-w-0 flex-1 text-xs leading-snug text-[var(--text-secondary)]">
        Score a property on twelve pillars, free.
      </p>
      <Link
        href="/search"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-brand-blue-500)] px-3 py-2 text-xs font-semibold text-white"
      >
        Start a search
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </Dock>
  );
};

const Dock = ({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <div
    role="region"
    aria-label={label}
    className={`fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 ${className ?? ''}`}
  >
    <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-2xl propiq-card/95 p-2 shadow-[0_18px_44px_-20px_rgba(13,21,36,0.45)] backdrop-blur">
      {children}
    </div>
  </div>
);
