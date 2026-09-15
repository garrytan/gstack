import type { Metadata } from 'next';
import Link from 'next/link';
import { YieldCalculator } from '@/components/propiq/tools/yield-calculator';
import { JsonLd, faqPage, webApplication } from '@/lib/structured-data';
import { ToolShell, ToolFaq } from '@/components/propiq/tools/tool-shell';

export const metadata: Metadata = {
  title: 'Rental yield calculator — gross vs net',
  description:
    'Gross yield is what gets quoted. Net yield on the capital you actually deployed is what ' +
    'decides whether the flat beats a fixed deposit. This works out both, with the gap. No signup.',
  alternates: { canonical: '/tools/rental-yield' },
};

const FAQ = [
  {
    question: 'What is the difference between gross and net rental yield?',
    answer:
      'Gross yield is annual rent divided by the purchase price, with nothing deducted. Net yield ' +
      'takes vacancy out of the rent, subtracts maintenance, property tax, insurance and other ' +
      'running costs, and divides by everything you deployed — purchase price plus stamp duty, ' +
      'registration, brokerage and fit-out. Gross yield is the number quoted to you; net yield is ' +
      'the number that decides the investment.',
  },
  {
    question: 'Why divide by more than the purchase price?',
    answer:
      'Because stamp duty, registration and fit-out are capital you will never see again, not an ' +
      'expense you can stop paying. A yield calculated on the price alone flatters the asset by ' +
      'pretending that money was free.',
  },
  {
    question: 'What vacancy assumption should I use?',
    answer:
      'Use what the specific building and unit type supports, not a market average. One month ' +
      'empty between tenants in a year is roughly 8%. A unit that turns over more often, or sits ' +
      'in a micro-market with heavy new supply, should carry more.',
  },
  {
    question: 'Does this account for appreciation or tax?',
    answer:
      'No, and that is deliberate. This is the income return on its own. Appreciation is a ' +
      'forecast rather than a measurement, and tax on rental income depends on your slab and your ' +
      'other deductions. Mixing forecasts into a yield figure is how yields get overstated.',
  },
  {
    question: 'What is a good rental yield in India?',
    answer:
      'Residential gross yields in Indian metros are typically low by global standards, which is ' +
      'why net yield matters so much. Rather than publish a benchmark we cannot source, compare ' +
      'the net figure this produces against what the same capital earns risk-free, and against ' +
      'the specific comparables in your micro-market.',
  },
];

export default function YieldToolPage() {
  return (
    <ToolShell
      eyebrow="Free tool"
      title="Rental yield, gross and net"
      standfirst={
        'The yield you are quoted divides rent by price and stops there. The yield you actually ' +
        'earn takes vacancy out of the rent, running costs out of the income, and divides by every ' +
        'rupee you deployed including stamp duty and registration. This shows both, and the gap.'
      }
    >
      <JsonLd
        data={webApplication({
          name: 'PropIQ rental yield calculator',
          description:
            'Gross and net rental yield, net annual income, running costs and capital payback ' +
            'period for a residential property.',
          path: '/tools/rental-yield',
          features: [
            'Gross rental yield',
            'Net rental yield on total capital deployed',
            'Vacancy-adjusted rent',
            'Annual running costs',
            'Years to return the capital',
          ],
        })}
      />
      <JsonLd data={faqPage(FAQ)} />

      <YieldCalculator />

      <ToolFaq items={FAQ} />

      <p className="mt-10 text-sm text-[var(--text-secondary)]">
        PropIQ&rsquo;s{' '}
        <Link href="/investment" className="text-accent-500 hover:underline">
          investment analysis
        </Link>{' '}
        takes this further: levered IRR by bisection, a break-even year, and bear, base and bull
        scenarios with every assumption listed.
      </p>
    </ToolShell>
  );
}
