import type { Metadata } from 'next';
import Link from 'next/link';
import { CarpetCalculator } from '@/components/propiq/tools/carpet-calculator';
import { JsonLd, faqPage, webApplication } from '@/lib/structured-data';
import { ToolShell, ToolFaq } from '@/components/propiq/tools/tool-shell';

export const metadata: Metadata = {
  title: 'Carpet area vs super built-up calculator',
  description:
    'Work out the loading on a flat, convert between carpet and super built-up area, and compare ' +
    'two quotes on the only rate that is comparable: price per carpet square foot. Free, no signup.',
  alternates: { canonical: '/tools/carpet-area' },
};

const FAQ = [
  {
    question: 'What is the difference between carpet area and super built-up area?',
    answer:
      'Carpet area is the net usable floor area inside the walls of the flat, including internal ' +
      'partition walls and excluding external walls, service shafts, balcony and open terrace. ' +
      'Super built-up area adds your share of common spaces such as lobbies, staircases, lifts and ' +
      'amenities. You live on the carpet area and you pay for the super built-up area.',
  },
  {
    question: 'What is loading in a property quote?',
    answer:
      'Loading is the gap between carpet area and super built-up area, expressed against the ' +
      'carpet. A 1,000 sqft carpet flat sold as 1,250 sqft super built-up carries 25% loading. ' +
      'There is no statutory cap on loading in India, which is why it varies widely between ' +
      'projects and why two flats quoted at the same rate per square foot can differ materially ' +
      'in usable space.',
  },
  {
    question: 'Is a builder required to disclose carpet area?',
    answer:
      'Yes. The Real Estate (Regulation and Development) Act requires carpet area to be disclosed ' +
      'in the agreement for sale, and defines it as the net usable floor area. A quote given only ' +
      'in super built-up terms is not enough to compare two projects.',
  },
  {
    question: 'Which rate should I compare projects on?',
    answer:
      'Price per carpet square foot. The advertised rate is calculated on super built-up area, ' +
      'which each builder defines differently, so it is not comparable across projects. Dividing ' +
      'the all-in price by carpet area gives a single figure that is.',
  },
  {
    question: 'What is a typical loading percentage in Bengaluru?',
    answer:
      'It varies by project and there is no reliable single figure, so we do not publish one. ' +
      'What matters for a decision is the loading on the specific flats you are comparing, which ' +
      'this calculator works out from the numbers on your own quotations.',
  },
];

export default function CarpetAreaToolPage() {
  return (
    <ToolShell
      eyebrow="Free tool"
      title="Carpet area vs super built-up"
      standfirst={
        'You live on the carpet area and you pay for the super built-up area. The gap between ' +
        'them is set by the builder with no statutory ceiling, so two flats quoted at the same ' +
        'rate per square foot can differ by a fifth in what you can actually furnish. Put your ' +
        'quotes in and compare them on the one rate that is comparable.'
      }
    >
      <JsonLd
        data={webApplication({
          name: 'PropIQ carpet area vs super built-up calculator',
          description:
            'Calculates loading, carpet efficiency and price per carpet square foot, and compares ' +
            'multiple quotes on a carpet basis.',
          path: '/tools/carpet-area',
          features: [
            'Loading percentage from carpet and super built-up area',
            'Carpet efficiency',
            'Price per carpet square foot',
            'Side-by-side comparison of multiple quotes',
            'Rupee cost of the loading',
          ],
        })}
      />
      <JsonLd data={faqPage(FAQ)} />

      <CarpetCalculator />

      <ToolFaq items={FAQ} />

      <p className="mt-10 text-sm text-[var(--text-secondary)]">
        Carpet efficiency is one of the twelve pillars PropIQ scores a property on. See{' '}
        <Link href="/methodology" className="text-[var(--text-accent)] hover:underline">
          the published methodology
        </Link>{' '}
        for how it is weighted, or{' '}
        <Link href="/tools" className="text-[var(--text-accent)] hover:underline">
          the other free tools
        </Link>
        .
      </p>
    </ToolShell>
  );
}
