import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { clientEnv } from '@/lib/env';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(clientEnv.NEXT_PUBLIC_SITE_URL),
  title: {
    default: 'PropIQ by CiteRank AI — Property Decision Intelligence',
    template: '%s · PropIQ',
  },
  description:
    'Verified data. Explainable intelligence. Better property decisions. PropIQ scores a property ' +
    'on twelve pillars, shows the evidence behind every number, and tells you what to negotiate.',
  applicationName: 'PropIQ',
  keywords: ['property intelligence', 'fair value', 'RERA', 'Bengaluru property', 'PropIQ Score'],
  openGraph: {
    type: 'website',
    siteName: 'PropIQ by CiteRank AI',
    title: 'PropIQ — India’s Property Decision Intelligence Platform',
    description: 'Verified data. Explainable intelligence. Better property decisions.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0e14' },
  ],
};

const NAV = [
  { href: '/search', label: 'Search' },
  { href: '/localities', label: 'Localities' },
  { href: '/compare', label: 'Decision Room' },
  { href: '/copilot', label: 'Copilot' },
  { href: '/document-ai', label: 'Documents' },
  { href: '/methodology', label: 'Methodology' },
  { href: '/data-sources', label: 'Data sources' },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-accent-500 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink-950"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--surface-0)]/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
            <Link href="/" className="flex items-baseline gap-1.5 font-semibold tracking-tight">
              <span>PropIQ</span>
              <span className="text-[10px] font-normal uppercase tracking-widest text-[var(--text-muted)]">
                by CiteRank AI
              </span>
            </Link>
            <nav aria-label="Main" className="hidden items-center gap-5 md:flex">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <Link
                href="/dashboard"
                className="text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                Dashboard
              </Link>
              <Link
                href="/login"
                className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-400"
              >
                Sign in
              </Link>
            </div>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="mt-16 border-t border-[var(--border-subtle)] bg-[var(--surface-1)]">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="font-semibold">PropIQ by CiteRank AI</p>
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                Property decision intelligence. Verified data, explainable scoring, and the evidence
                behind every number.
              </p>
            </div>
            <FooterColumn
              title="Product"
              links={[
                { href: '/search', label: 'Search' },
                { href: '/compare', label: 'Decision Room' },
                { href: '/copilot', label: 'Copilot' },
                { href: '/document-ai', label: 'Document checks' },
                { href: '/document-ai', label: 'Documents' },
                { href: '/valuation', label: 'Fair value' },
                { href: '/investment', label: 'Investment analysis' },
                { href: '/copilot', label: 'Copilot' },
                { href: '/document-ai', label: 'Document checks' },
                { href: '/document-ai', label: 'Documents' },
              ]}
            />
            <FooterColumn
              title="Trust"
              links={[
                { href: '/methodology', label: 'Methodology' },
                { href: '/data-sources', label: 'Data sources' },
                { href: '/about', label: 'About' },
              ]}
            />
            <FooterColumn
              title="Account"
              links={[
                { href: '/login', label: 'Sign in' },
                { href: '/signup', label: 'Create account' },
                { href: '/dashboard', label: 'Dashboard' },
                { href: '/preferences', label: 'Preferences' },
              ]}
            />
          </div>
          <div className="border-t border-[var(--border-subtle)] px-4 py-4">
            <p className="mx-auto max-w-7xl text-[11px] text-[var(--text-muted)]">
              PropIQ produces decision support, not investment, legal or tax advice. Every estimate
              carries a confidence band and a source. Nothing here is a substitute for your own
              diligence or a qualified professional.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

const FooterColumn = ({
  title,
  links,
}: {
  title: string;
  links: ReadonlyArray<{ href: string; label: string }>;
}) => (
  <nav aria-label={title}>
    <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {title}
    </p>
    <ul className="mt-3 space-y-2">
      {links.map((l) => (
        <li key={l.href}>
          <Link
            href={l.href}
            className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {l.label}
          </Link>
        </li>
      ))}
    </ul>
  </nav>
);
