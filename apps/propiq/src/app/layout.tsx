import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import { clientEnv } from '@/lib/env';
import './globals.css';

/**
 * Typography.
 *
 * `next/font` downloads these at build time and serves them from our own
 * origin, so there is no runtime request to a font host and no layout shift
 * waiting for one. Two faces, each with a job: Archivo carries headlines and
 * figures because it is an industrial grotesk that holds its shape at display
 * size, and Plex Mono sets every number, because a product whose whole point
 * is comparing figures should line its digits up.
 */
const display = Archivo({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono-figures',
  display: 'swap',
});

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning className={`${display.variable} ${mono.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
