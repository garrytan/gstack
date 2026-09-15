/**
 * Site header.
 *
 * Every item points at a route that exists. The brief's labels — Buy, Invest,
 * Projects, Localities, Developers, Research — are mapped onto the real
 * surfaces rather than onto pages that would 404, because `navigation.test.ts`
 * fails the build on a dead link and, more to the point, a nav item that goes
 * nowhere is the first thing a visitor finds out is not real.
 */

import Link from 'next/link';
import { BrandMark } from '@/components/brand/brand-mark';
import { MobileNavigation } from '@/components/site/mobile-navigation';

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

export const SITE_NAV: readonly NavItem[] = [
  { href: '/search', label: 'Buy' },
  { href: '/investment', label: 'Invest' },
  { href: '/compare', label: 'Projects' },
  { href: '/localities', label: 'Localities' },
  { href: '/developers', label: 'Developers' },
  { href: '/research', label: 'Research' },
];

export const SiteHeader = () => (
  <header className="sticky top-0 z-50 border-b border-[var(--border-subtle)] bg-[var(--surface-0)]/85 backdrop-blur-xl">
    <div className="mx-auto flex h-[78px] max-w-7xl items-center gap-4 px-4 transition-[height] lg:gap-8 duration-200">
      <BrandMark />

      <nav aria-label="Main" className="hidden items-center gap-6 lg:flex">
        {SITE_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-sm text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <Link
          href="/login"
          className="hidden rounded-md px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] sm:inline-flex"
        >
          Login
        </Link>
        <Link
          href="/search"
          className="propiq-brand-gradient inline-flex h-10 items-center whitespace-nowrap rounded-md px-3 text-[13px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 sm:px-4 sm:text-sm"
        >
          {/* Below `sm` the full label pushes the header past a 375px
              viewport and the whole page starts scrolling sideways. The short
              label is the same destination, not a different action. */}
          <span className="sm:hidden">Analyze</span>
          <span className="hidden sm:inline">Analyze Property</span>
        </Link>
        <MobileNavigation items={SITE_NAV} />
      </div>
    </div>
  </header>
);
