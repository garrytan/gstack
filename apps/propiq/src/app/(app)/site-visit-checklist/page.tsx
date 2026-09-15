import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { CHECKLIST } from '@/domain/visits/checklist';
import { CATEGORY_LABELS, VISIT_CATEGORIES } from '@/domain/visits/types';
import type { VisitCategory } from '@/domain/visits/types';
import { PrintButton } from '@/components/propiq/print-button';
import { JsonLd, ORGANIZATION, faqPage } from '@/lib/structured-data';
import { ToolFaq } from '@/components/propiq/tools/tool-shell';

export const metadata: Metadata = {
  title: 'Site visit checklist for buying a flat in India',
  description:
    '22 questions you can only answer by standing there — water source, transformer sizing, ' +
    'monsoon silt lines, what is approved next door — each with why it matters. Free, printable.',
  alternates: { canonical: '/site-visit-checklist' },
};

const FAQ = [
  {
    question: 'What should I check on a site visit before buying a flat?',
    answer:
      'The things a brochure cannot tell you: the actual water source and whether tankers are ' +
      'used, transformer and backup sizing against the number of units, silt lines on the ' +
      'compound wall that reveal monsoon flooding, construction quality in the common areas ' +
      'rather than the show flat, what is approved to be built on adjacent plots, and whether ' +
      'the paperwork on site matches what you were sent.',
  },
  {
    question: 'When is the best time to visit a site?',
    answer:
      'Twice, deliberately. Once on a weekday morning to see the commute, the construction ' +
      'activity and the water supply in use, and once in the evening or at a weekend to see ' +
      'parking pressure, noise and how full the building actually is. If you can only go once, ' +
      'go during or just after rain.',
  },
  {
    question: 'What questions should I ask the builder on site?',
    answer:
      'Ask for specifics with numbers attached rather than assurances: what the project spent on ' +
      'water tankers last April, the transformer capacity against the unit count, the backup load ' +
      'per flat, the current occupancy, and the committed possession date in writing against the ' +
      'one in the RERA registration.',
  },
  {
    question: 'Can I use this checklist for a resale flat?',
    answer:
      'Yes, and several items matter more on resale. Water source, seepage history, transformer ' +
      'adequacy and the state of common areas all tell you what the building has become since ' +
      'handover, which no amount of interior work in the specific flat can hide.',
  },
];

export default function SiteVisitChecklistPage() {
  const material = CHECKLIST.filter((i) => i.material).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'HowTo',
          name: 'Site visit checklist for buying a flat in India',
          description:
            'What to check on a property site visit, grouped by water, power, construction, the ' +
            'unit, surroundings, access, amenities and paperwork.',
          totalTime: 'PT90M',
          publisher: ORGANIZATION(),
          step: VISIT_CATEGORIES.map((category) => ({
            '@type': 'HowToSection',
            name: CATEGORY_LABELS[category],
            itemListElement: CHECKLIST.filter((i) => i.category === category).map((item) => ({
              '@type': 'HowToStep',
              name: item.question,
              text: item.why,
            })),
          })),
        }}
      />
      <JsonLd data={faqPage(FAQ)} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-500">
            Free, no account
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Site visit checklist
          </h1>
        </div>
        <div className="print:hidden">
          <PrintButton />
        </div>
      </div>

      <p className="mt-4 max-w-2xl text-[var(--text-secondary)]">
        {CHECKLIST.length} things you can only learn standing there, and every one of them has cost
        somebody money by being skipped. {material} are marked serious enough to change a decision
        on their own. Each carries why it matters, because a checklist nobody understands gets
        ticked through.
      </p>

      <p className="mt-4 max-w-2xl text-sm text-[var(--text-secondary)] print:hidden">
        Print it, or send this link to whoever is going with you. If you are tracking a specific
        property in PropIQ,{' '}
        <Link href="/search" className="text-accent-500 hover:underline">
          the in-app version
        </Link>{' '}
        records your answers as first-party evidence and moves that property&rsquo;s score.
      </p>

      <div className="mt-10 space-y-8">
        {VISIT_CATEGORIES.map((category) => (
          <Section key={category} category={category} />
        ))}
      </div>

      <div className="print:hidden">
        <ToolFaq items={FAQ} />
      </div>
    </div>
  );
}

const Section = ({ category }: { category: VisitCategory }) => {
  const items = CHECKLIST.filter((i) => i.category === category);
  if (items.length === 0) return null;

  return (
    <section className="break-inside-avoid">
      <h2 className="border-b border-[var(--border-subtle)] pb-2 text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {CATEGORY_LABELS[category]}
      </h2>
      <ol className="mt-4 space-y-5">
        {items.map((item) => (
          <li key={item.id} className="flex gap-3 break-inside-avoid">
            <span
              aria-hidden
              className="mt-1 size-4 shrink-0 rounded border border-[var(--border-strong)]"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {item.question}
                {item.material && (
                  <span className="ml-2 inline-flex items-center gap-1 align-middle text-[10px] font-semibold uppercase tracking-wide text-[var(--color-negotiate)]">
                    <AlertTriangle aria-hidden className="size-3" />
                    Deal-changing
                  </span>
                )}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
                {item.why}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
};
