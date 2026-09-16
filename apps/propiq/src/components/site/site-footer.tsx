/**
 * Site footer.
 *
 * Every link resolves to a real route; `navigation.test.ts` fails the build
 * otherwise, which is the point of having it.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { BrandMark } from '@/components/brand/brand-mark';
import { NodeField } from '@/components/site/intelligence-nodes';

const COLUMNS = [
  {
    title: 'Platform',
    links: [
      { href: '/search', label: 'Properties' },
      { href: '/compare', label: 'Projects' },
      { href: '/localities', label: 'Localities' },
      { href: '/decision-room', label: 'Compare' },
      { href: '/document-ai', label: 'Analyze' },
    ],
  },
  {
    title: 'Intelligence',
    links: [
      { href: '/valuation', label: 'Price intelligence' },
      { href: '/localities', label: 'Location intelligence' },
      { href: '/developers', label: 'Developer intelligence' },
      { href: '/investment', label: 'Investment intelligence' },
      { href: '/methodology', label: 'Risk and scoring' },
    ],
  },
  {
    title: 'Research',
    links: [
      { href: '/research', label: 'Market reports' },
      { href: '/tools', label: 'Free tools' },
      { href: '/site-visit-checklist', label: 'Site visit checklist' },
      { href: '/checks/khata', label: 'Document guides' },
      { href: '/data-sources', label: 'Data sources' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/about', label: 'About' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/signup', label: 'Create account' },
      { href: '/login', label: 'Login' },
    ],
  },
] as const;

export const SiteFooter = () => (
  <footer className="relative isolate overflow-hidden border-t border-[var(--border-subtle)] bg-[var(--surface-1)]">
    {/* ---------------------------------------------------- the last word */}
    <div className="relative border-b border-[var(--border-subtle)]">
      {/* The motif's last appearance, at its quietest. It opens the page and
          closes it, and in between it earns its keep behind the score. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.45]">
        <NodeField />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 py-20 sm:py-24">
        <p className="propiq-display max-w-3xl text-balance text-[2.1rem] leading-[1.06] tracking-[-0.03em] sm:text-[3rem] lg:text-[3.4rem]">
          Don&rsquo;t just find a property.
          <br />
          <span className="propiq-iris-text">Understand it.</span>
        </p>
        <Link
          href="/valuation"
          className="propiq-btn-primary mt-8 inline-flex h-12 items-center gap-2 rounded-lg px-6 text-sm font-semibold text-white"
        >
          Start your property analysis <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
    </div>

    <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 lg:grid-cols-[minmax(0,1.3fr)_repeat(4,minmax(0,1fr))]">
      <div>
        {/* The glyph cut, not the supplied lockup. This footer is light on
            every route but the homepage, where it is deep teal — and the
            lockup's light ground and near-black wordmark only work on the
            first. One cut that holds on both beats two that each break
            somewhere. */}
        <BrandMark />
        <p className="propiq-brand-text mt-3 text-sm font-semibold">Cities. Insights. Growth.</p>
        <p className="mt-3 max-w-xs text-xs leading-relaxed text-[var(--text-secondary)]">
          Property decision intelligence. Verified data, explainable scoring, and the evidence
          behind every number.
        </p>
      </div>

      {COLUMNS.map((column) => (
        <nav key={column.title} aria-label={column.title}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            {column.title}
          </p>
          <ul className="mt-4 space-y-2.5">
            {column.links.map((link) => (
              <li key={`${column.title}-${link.href}-${link.label}`}>
                <Link
                  href={link.href}
                  className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ))}
    </div>

    <div className="border-t border-[var(--border-subtle)]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-5">
        <p className="max-w-3xl text-[11px] leading-relaxed text-[var(--text-muted)]">
          PropIQ provides informational property intelligence and does not replace legal, financial,
          tax, engineering, or investment advice. Every estimate carries a confidence band and a
          source.
        </p>
        {/* A labelled group, and every link goes where its label says. "Privacy"
            and "Terms" both pointed at /about, which carries neither. Terms of
            service do not exist yet, so there is no link for them rather than
            one that lands somewhere else. */}
        <nav aria-label="Legal">
          <ul className="flex gap-4 text-[11px] text-[var(--text-muted)]">
            <li>
              <Link href="/privacy" className="hover:text-[var(--text-primary)]">
                Privacy
              </Link>
            </li>
            <li>
              <Link href="/about#what-this-is-not" className="hover:text-[var(--text-primary)]">
                Disclaimer
              </Link>
            </li>
            <li>
              <Link href="/methodology" className="hover:text-[var(--text-primary)]">
                Methodology
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  </footer>
);
