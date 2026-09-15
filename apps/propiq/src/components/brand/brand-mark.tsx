/**
 * The PropIQ mark.
 *
 * No logo file has been supplied, and the brief is explicit that the logo is
 * the source of truth and must not be recreated in CSS or hand-drawn SVG. So
 * this renders the typographic wordmark and picks the real asset up the
 * moment one is dropped into `public/brand/` — checked on the server at
 * render time, which costs one stat call and removes the need to remember to
 * come back and wire it.
 *
 * The infinity-loop identity is deliberately not approximated. A shape that
 * is nearly the logo is worse than an honest wordmark that is not pretending
 * to be it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Image from 'next/image';
import Link from 'next/link';

/** Preference order. The first that exists wins. */
const CANDIDATES = [
  { file: 'propiq-logo.svg', src: '/brand/propiq-logo.svg' },
  { file: 'propiq-logo.png', src: '/brand/propiq-logo.png' },
] as const;

const suppliedLogo = (): string | undefined => {
  const root = join(process.cwd(), 'public', 'brand');
  return CANDIDATES.find((c) => existsSync(join(root, c.file)))?.src;
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
  const logo = suppliedLogo();

  return (
    <Link
      href={href}
      className={`group inline-flex items-center gap-2.5 ${className ?? ''}`}
      aria-label="PropIQ by CiteRank AI — home"
    >
      {logo ? (
        <Image
          src={logo}
          alt="PropIQ by CiteRank AI"
          width={132}
          height={32}
          priority
          className="h-8 w-auto"
        />
      ) : (
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="display text-[19px] font-bold tracking-tight">
            Prop<span className="propiq-brand-text">IQ</span>
          </span>
          {/* Tracking this wide wraps to three lines in a 390px header, and a
              wordmark that wraps stops being a wordmark. Below 360px even the
              nowrap version pushes the header past the viewport, so the
              qualifier drops rather than the page scrolling sideways. */}
          <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)] max-[359px]:hidden sm:tracking-[0.18em]">
            by CiteRank AI
          </span>
        </span>
      )}
      {showTagline && (
        <span className="hidden text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)] sm:inline">
          Cities. Insights. Growth.
        </span>
      )}
    </Link>
  );
};
