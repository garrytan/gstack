import type { Metadata } from 'next';
import Link from 'next/link';
import { ToolCard } from '@/components/propiq/tools/tool-shell';
import { JsonLd, ORGANIZATION } from '@/lib/structured-data';

export const metadata: Metadata = {
  title: 'Free property tools',
  description:
    'Carpet area vs super built-up, home loan EMI with total interest, rental yield gross and net, ' +
    'document checks and a site-visit checklist. All free, no account, nothing stored.',
  alternates: { canonical: '/tools' },
};

const TOOLS = [
  {
    href: '/tools/carpet-area',
    title: 'Carpet area vs super built-up',
    blurb:
      'Work out the loading, convert between the two, and compare quotes on price per carpet square foot — the only rate that is comparable across projects.',
  },
  {
    href: '/tools/emi',
    title: 'Home loan EMI, and the total interest',
    blurb:
      'The monthly instalment, plus the number nobody shows you: what the loan costs over the full tenure, year by year.',
  },
  {
    href: '/tools/rental-yield',
    title: 'Rental yield, gross and net',
    blurb:
      'Gross yield is what gets quoted. Net yield on all capital deployed is what decides whether the flat beats a fixed deposit.',
  },
  {
    href: '/document-ai',
    title: 'Document checks',
    blurb:
      '22 checks across sale deeds, encumbrance certificates, khata, agreements, RERA certificates and cost sheets. Runs in your browser — nothing is uploaded.',
  },
  {
    href: '/site-visit-checklist',
    title: 'Site-visit checklist',
    blurb:
      '22 things you can only learn standing there, each with why it matters. Print it or send it to whoever is going with you.',
  },
] as const;

export default function ToolsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: 'Free property tools',
          description:
            'Free calculators and checklists for Indian property buyers. No account, nothing stored.',
          publisher: ORGANIZATION(),
        }}
      />

      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-accent)]">
        Free tools
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
        The arithmetic, for free, with no account
      </h1>
      <p className="mt-4 max-w-2xl text-[var(--text-secondary)]">
        These do not depend on our data, so they are correct for any property in any Indian market.
        Nothing here asks for an email, sends anything to a server, or stores what you type. Use
        them on a builder&rsquo;s sofa if you want to.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {TOOLS.map((t) => (
          <ToolCard key={t.href} {...t} />
        ))}
      </div>

      <div className="mt-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-5">
        <h2 className="text-sm font-semibold">Where the tools stop and the product starts</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--text-secondary)]">
          A calculator answers a question you already know to ask. PropIQ scores a specific property
          on twelve pillars, values it against comparables with a confidence band, and tells you
          whether to buy, negotiate, watch or walk — and what to argue about.{' '}
          <Link href="/methodology" className="text-[var(--text-accent)] hover:underline">
            The formula is published
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
