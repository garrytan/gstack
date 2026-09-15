import type { Metadata } from 'next';
import Link from 'next/link';
import { EmiCalculator } from '@/components/propiq/tools/emi-calculator';
import { JsonLd, faqPage, webApplication } from '@/lib/structured-data';
import { ToolShell, ToolFaq } from '@/components/propiq/tools/tool-shell';

export const metadata: Metadata = {
  title: 'Home loan EMI calculator, with the total interest',
  description:
    'Monthly instalment, total interest and a year-by-year repayment schedule on reducing-balance ' +
    'arithmetic. Shows what the loan actually costs, not just what it costs per month. No signup.',
  alternates: { canonical: '/tools/emi' },
};

const FAQ = [
  {
    question: 'How is EMI calculated?',
    answer:
      'EMI = P·r·(1+r)^n ÷ ((1+r)^n − 1), where P is the principal, r is the monthly interest ' +
      'rate (annual rate divided by twelve hundred) and n is the number of months. Indian home ' +
      'loans are reducing-balance, so interest each month is charged on the outstanding balance, ' +
      'not the original amount.',
  },
  {
    question: 'Why is so much of my early EMI going to interest?',
    answer:
      'Because interest is charged on the outstanding balance, which is highest at the start. On ' +
      'a twenty-year loan the first year is usually more than three-quarters interest. This is ' +
      'also why prepaying in year three is worth many times prepaying in year fifteen: you remove ' +
      'principal that would otherwise have accrued interest for seventeen more years.',
  },
  {
    question: 'Does a shorter tenure or a lower rate save more?',
    answer:
      'Tenure usually moves the total more than a small rate difference does. Shortening a ' +
      'twenty-year loan to fifteen raises the instalment but cuts total interest substantially. ' +
      'Change the tenure field above and watch the total interest figure rather than the EMI.',
  },
  {
    question: 'Does this include processing fees, insurance or stamp duty?',
    answer:
      'No. This calculates the loan alone. Stamp duty, registration, processing fees and any ' +
      'bundled insurance are separate and are paid up front, so they sit outside the amortisation. ' +
      'The rental yield tool treats them as capital deployed, which is where they belong.',
  },
  {
    question: 'What interest rate should I use?',
    answer:
      'Your own sanctioned rate. We do not quote lender rates here, because a rate advertised on ' +
      'a comparison site is rarely the rate a specific borrower is offered, and a calculator that ' +
      'implied otherwise would be giving you a number we cannot stand behind.',
  },
];

export default function EmiToolPage() {
  return (
    <ToolShell
      eyebrow="Free tool"
      title="Home loan EMI, and what the loan really costs"
      standfirst={
        'Every EMI calculator gives you the monthly figure. The number that decides how much the ' +
        'house actually cost is the total interest over the tenure, and almost nobody is shown it ' +
        'before they sign. Both are here, with the year-by-year split.'
      }
    >
      <JsonLd
        data={webApplication({
          name: 'PropIQ home loan EMI calculator',
          description:
            'Monthly instalment, total interest, and a year-by-year amortisation schedule for a ' +
            'reducing-balance home loan.',
          path: '/tools/emi',
          features: [
            'Monthly EMI on reducing-balance arithmetic',
            'Total interest over the full tenure',
            'Year-by-year interest and principal split',
            'Outstanding balance by year',
          ],
        })}
      />
      <JsonLd data={faqPage(FAQ)} />

      <EmiCalculator />

      <ToolFaq items={FAQ} />

      <p className="mt-10 text-sm text-[var(--text-secondary)]">
        The same arithmetic drives PropIQ&rsquo;s{' '}
        <Link href="/investment" className="text-accent-500 hover:underline">
          investment analysis
        </Link>
        , where the loan sits inside a full cash-flow model with yield, IRR and scenarios.
      </p>
    </ToolShell>
  );
}
