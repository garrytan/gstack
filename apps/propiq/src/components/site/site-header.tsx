/**
 * The site header.
 *
 * A mega menu rather than six flat links, because the product has four
 * genuinely different surfaces behind it and a flat bar made them look like
 * one. Every destination is in `site-nav.ts`, which the mobile sheet and the
 * command palette read too — three copies of a menu is three chances for one of
 * them to point somewhere that does not exist.
 *
 * This stays a SERVER component. `BrandMark` checks the brand files on disk
 * with `existsSync` at render, so marking the header `'use client'` pulls
 * `node:fs` into the browser graph and the build fails outright. The two parts
 * that need the browser — the disclosure menu and the palette trigger — are
 * client islands inside it, which is also less JavaScript than shipping the
 * whole bar.
 */

import Link from 'next/link';
import { BrandMark } from '@/components/brand/brand-mark';
import { MobileNavigation } from '@/components/site/mobile-navigation';
import { MegaMenuNav } from '@/components/site/mega-menu-nav';
import { PaletteTrigger } from '@/components/site/palette-trigger';
import { NAV_LINKS } from '@/components/site/site-nav';

/** Kept for the tests and callers that only want a flat list. */
export type { NavLink as NavItem } from '@/components/site/site-nav';
export const SITE_NAV = NAV_LINKS;

export const SiteHeader = () => (
  <header className="sticky top-0 z-50 border-b border-[var(--border-subtle)] bg-[var(--surface-0)]/80 backdrop-blur-xl">
    <div className="mx-auto flex h-[72px] max-w-7xl items-center gap-3 px-4 lg:gap-4 xl:gap-7">
      <BrandMark />

      <MegaMenuNav />

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <PaletteTrigger />

        <Link
          href="/login"
          className="hidden rounded-md px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] sm:inline-flex"
        >
          Login
        </Link>
        <Link
          href="/valuation"
          className="propiq-btn-primary inline-flex h-10 items-center whitespace-nowrap rounded-lg px-3 text-[13px] font-semibold text-white sm:px-4 sm:text-sm"
        >
          {/* Below `sm` the full label pushes the header past a 375px
                viewport and the whole page starts scrolling sideways. The
                short label is the same destination, not a different action. */}
          <span className="sm:hidden">Analyze</span>
          <span className="hidden sm:inline">Analyze Property</span>
        </Link>
        <MobileNavigation items={NAV_LINKS} />
      </div>
    </div>
  </header>
);
