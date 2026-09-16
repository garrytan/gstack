/**
 * The PropIQ mark.
 *
 * The supplied identity is a square, stacked lockup: the infinity-and-skyline
 * glyph above the wordmark above the tagline, on a light ground. That shape
 * cannot serve a 32px-tall header slot — at that height the whole lockup is a
 * smudge — and the wordmark's near-black "Prop" is unreadable on the dark
 * teal header. So the two surfaces take different cuts of the same artwork:
 *
 *   `BrandMark`    the glyph alone, alpha-cut from the supplied file, beside
 *                  the wordmark set in the site's own face. Legible at header
 *                  scale and on either ground, so it carries the chrome — the
 *                  header and footer are dark teal on the homepage and light
 *                  on every other route, and one cut has to hold on both.
 *   `BrandLockup`  the supplied artwork whole, for a light surface with the
 *                  room to show it properly. Not a link: it is the brand being
 *                  shown, not a way back to the homepage.
 *
 * Nothing here is drawn by hand. Both cuts are pixels from the supplied file;
 * see `public/brand/README.md` for how they were produced.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Image from 'next/image';
import Link from 'next/link';

const BRAND_DIR = join(process.cwd(), 'public', 'brand');

/** Present only once the asset is actually on disk, so a fork without the
 *  brand files still renders an honest wordmark rather than a broken image. */
const supplied = (file: string): boolean => existsSync(join(BRAND_DIR, file));

/** The supplied lockup, whole. Renders nothing when the asset is absent —
 *  a decorative brand image is not worth a broken-image icon. */
export const BrandLockup = ({ className, width = 220 }: { className?: string; width?: number }) => {
  if (!supplied('propiq-lockup.png')) return null;
  return (
    <Image
      src="/brand/propiq-lockup.png"
      alt="PropIQ by CiteRank AI — Cities. Insights. Growth."
      width={700}
      height={678}
      sizes={`${width}px`}
      style={{ width, height: 'auto' }}
      className={className}
    />
  );
};

export const BrandMark = ({
  href = '/',
  showTagline = false,
  className,
}: {
  href?: string;
  showTagline?: boolean;
  className?: string;
}) => {
  const hasMark = supplied('propiq-mark.png');

  return (
    <Link
      href={href}
      className={`group inline-flex items-center gap-2.5 ${className ?? ''}`}
      aria-label="PropIQ by CiteRank AI — home"
    >
      {hasMark && (
        <Image
          src="/brand/propiq-mark.png"
          alt=""
          width={419}
          height={256}
          priority
          className="h-7 w-auto shrink-0"
        />
      )}
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="display text-[19px] font-bold tracking-tight">
          Prop<span className="propiq-brand-text">IQ</span>
        </span>
        {/* Tracking this wide wraps to three lines in a 390px header, and a
            wordmark that wraps stops being a wordmark. Below 360px even the
            nowrap version pushes the header past the viewport, so the
            qualifier drops rather than the page scrolling sideways. The glyph
            drops with it — at 320px the header has room for one or the other. */}
        <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)] max-[359px]:hidden sm:tracking-[0.18em]">
          by CiteRank AI
        </span>
      </span>
      {showTagline && (
        <span className="hidden text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)] sm:inline">
          Cities. Insights. Growth.
        </span>
      )}
    </Link>
  );
};
