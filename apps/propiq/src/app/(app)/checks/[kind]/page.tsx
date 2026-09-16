import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { DOCUMENT_LABELS } from '@/domain/documents/types';
import type { DocumentKind } from '@/domain/documents/types';
import { DOCUMENT_RULES_VERSION, rulesFor } from '@/domain/documents/rules';
import { JsonLd, ORGANIZATION, faqPage } from '@/lib/structured-data';
import { ToolFaq } from '@/components/propiq/tools/tool-shell';

/**
 * A landing page per document type.
 *
 * Each one is a real question a buyer types — "what to check in an
 * encumbrance certificate" — answered with the exact rules the product runs,
 * rather than a generic article that ends in a signup wall. The checks
 * themselves live at /document-ai and run in the browser.
 *
 * Only the document types with checks worth a standalone page are routed.
 * A page listing two rules would be thin, and thin pages are how a site
 * teaches an engine not to cite it.
 */

const SLUGS: Readonly<Record<string, DocumentKind>> = {
  'sale-deed': 'saleDeed',
  'encumbrance-certificate': 'encumbranceCertificate',
  khata: 'khata',
  'agreement-to-sell': 'agreementToSell',
  'rera-certificate': 'reraCertificate',
  'cost-sheet': 'costSheet',
};

interface Copy {
  readonly standfirst: string;
  readonly faq: ReadonlyArray<{ question: string; answer: string }>;
}

const COPY: Readonly<Record<DocumentKind, Copy | undefined>> = {
  saleDeed: {
    standfirst:
      'The sale deed is the instrument that actually transfers ownership. Most disputes trace ' +
      'back to something that was visible on its face and nobody read closely.',
    faq: [
      {
        question: 'What should I check in a sale deed?',
        answer:
          'That the seller named is the person with the right to sell, that the schedule of ' +
          'property matches what you are buying including boundaries and measurements, that the ' +
          'consideration stated is the consideration paid, that it is registered with the ' +
          'sub-registrar, and that it carries the witnesses the Registration Act requires.',
      },
      {
        question: 'How many witnesses does a sale deed need in India?',
        answer:
          'Two. The Registration Act requires the deed to be attested by two witnesses, and a ' +
          'deed presented with fewer is defective on its face.',
      },
      {
        question: 'Does a registered sale deed guarantee clear title?',
        answer:
          'No. Registration records the transaction; it does not certify that the seller had good ' +
          'title to transfer. That is what the encumbrance certificate, the parent documents and ' +
          'a title search are for, and why every finding here is phrased as a question to ask ' +
          'your advocate rather than a conclusion about title.',
      },
    ],
  },
  encumbranceCertificate: {
    standfirst:
      'An encumbrance certificate lists the transactions registered against a property over a ' +
      'period. Its value is entirely in the period it covers, which is the part people skip.',
    faq: [
      {
        question: 'How many years should an encumbrance certificate cover?',
        answer:
          'Long enough to cover the limitation period for a claim, which in practice means at ' +
          'least thirteen years and preferably thirty. A certificate covering five years proves ' +
          'nothing about a charge created six years ago, and a five-year EC offered for a thirty ' +
          'year old property is a gap, not a clearance.',
      },
      {
        question: 'What does a nil encumbrance certificate mean?',
        answer:
          'That no transaction was registered against the property during the period searched. ' +
          'It does not mean there is no claim: unregistered agreements, oral partitions, ' +
          'inheritance disputes and litigation do not appear on an EC.',
      },
      {
        question: 'Does an encumbrance certificate show a home loan?',
        answer:
          'A mortgage created by a registered deed appears. An equitable mortgage by deposit of ' +
          'title deeds, which is the common form for home loans, frequently does not. Absence of ' +
          'a mortgage entry is not evidence that the property is unencumbered.',
      },
    ],
  },
  khata: {
    standfirst:
      'Khata is the municipal record of who is liable for property tax. In Karnataka the A and B ' +
      'split decides whether a bank will lend against the property at all.',
    faq: [
      {
        question: 'What is the difference between A khata and B khata?',
        answer:
          'An A khata property is on the main municipal register and is treated as fully ' +
          'regularised. A B khata property is on a separate register maintained for properties ' +
          'that are not fully compliant with building or layout approvals. The practical ' +
          'consequence is that most banks will not sanction a home loan against a B khata ' +
          'property and a plan sanction cannot be obtained for it.',
      },
      {
        question: 'Can B khata be converted to A khata?',
        answer:
          'Conversion has been possible through regularisation schemes, but availability and ' +
          'terms have changed repeatedly and depend on why the property was classified B in the ' +
          'first place. Treat a promised future conversion as a risk you are carrying, not a ' +
          'condition that is already met.',
      },
      {
        question: 'Is khata proof of ownership?',
        answer:
          'No. Khata records tax liability, not title. A khata in the seller’s name alongside ' +
          'a defective chain of title is not ownership, and a clean title with the khata not yet ' +
          'transferred is a paperwork problem rather than a title problem.',
      },
    ],
  },
  agreementToSell: {
    standfirst:
      'The agreement to sell is where the terms are set, and where the asymmetry usually lives: ' +
      'a clause that can forfeit your deposit alongside no penalty for the builder’s delay.',
    faq: [
      {
        question: 'What should I look for in an agreement to sell?',
        answer:
          'Whether the penalties are symmetric. An agreement that forfeits your deposit on your ' +
          'default but carries no compensation for the builder’s delay is not a balanced ' +
          'contract. Also check that the carpet area is stated, the payment schedule is tied to ' +
          'construction milestones rather than dates, and the possession date is specific.',
      },
      {
        question: 'How much can a builder collect before the agreement is registered?',
        answer:
          'RERA caps the amount that may be collected before a registered agreement for sale at ' +
          'ten percent of the cost of the apartment. A demand above that before registration is ' +
          'not permitted.',
      },
      {
        question: 'Should the agreement to sell be registered?',
        answer:
          'Yes, where the law requires it, and in any case it is in your interest. An ' +
          'unregistered agreement is weak evidence and in several states is inadmissible to prove ' +
          'the transaction it records.',
      },
    ],
  },
  reraCertificate: {
    standfirst:
      'RERA registration is a project-level fact you can verify independently. The registration ' +
      'number, its validity date and the declared possession date are the three things to read.',
    faq: [
      {
        question: 'How do I verify a RERA registration number?',
        answer:
          'Look it up on the state RERA authority’s own portal rather than trusting a number ' +
          'printed in a brochure. Check that the project name, the promoter and the declared ' +
          'possession date match what you have been told, and check whether the registration is ' +
          'still valid or has lapsed.',
      },
      {
        question: 'What does an expired RERA registration mean?',
        answer:
          'That the project is past the completion date it registered for. Extensions exist and ' +
          'are sometimes routine, but an expired registration is a question to put to the ' +
          'promoter in writing, and the answer belongs in your file.',
      },
      {
        question: 'Does RERA registration mean the project is safe to buy?',
        answer:
          'No. Registration is a disclosure obligation, not a quality certificate. It gives you ' +
          'verifiable facts — promoter, approvals, timelines, complaints — and those facts are ' +
          'what a decision should rest on.',
      },
    ],
  },
  costSheet: {
    standfirst:
      'The cost sheet is where the advertised rate turns into what you will actually pay, once ' +
      'floor rise, preferential location charges, parking, club and deposits are added.',
    faq: [
      {
        question: 'What is usually hidden in a builder cost sheet?',
        answer:
          'The gap between the headline rate and the all-in figure. Floor rise, preferential ' +
          'location charges, covered parking, club membership, infrastructure and corpus deposits ' +
          'and maintenance advances are typically listed separately and can add materially to the ' +
          'total. Compare projects on the all-in number divided by carpet area, never on the ' +
          'advertised rate.',
      },
      {
        question: 'Are stamp duty and registration included in the cost sheet?',
        answer:
          'Usually not, and they are substantial. Read them as capital you are deploying rather ' +
          'than a formality, which is how the rental yield calculator treats them.',
      },
      {
        question: 'Can I negotiate the charges on a cost sheet?',
        answer:
          'Often more easily than the headline rate, because a discount on the rate is visible to ' +
          'every other buyer and a waived club charge is not. Ask for the line items to be listed ' +
          'and priced separately before discussing any of them.',
      },
    ],
  },
  sanctionedPlan: undefined,
  loanSanction: undefined,
};

export const generateStaticParams = () => Object.keys(SLUGS).map((kind) => ({ kind }));

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ kind: string }>;
}): Promise<Metadata> => {
  const { kind } = await params;
  const documentKind = SLUGS[kind];
  const copy = documentKind ? COPY[documentKind] : undefined;
  if (!documentKind || !copy) return {};

  const label = DOCUMENT_LABELS[documentKind];
  return {
    title: `What to check in a ${label.toLowerCase()}`,
    description:
      `The ${rulesFor(documentKind).length} checks PropIQ runs on a ${label.toLowerCase()}, ` +
      'and why each one matters. Runs in your browser — nothing is uploaded. Free, no account.',
    alternates: { canonical: `/checks/${kind}` },
  };
};

export default async function DocumentCheckPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const documentKind = SLUGS[kind];
  const copy = documentKind ? COPY[documentKind] : undefined;
  if (!documentKind || !copy) notFound();

  const label = DOCUMENT_LABELS[documentKind];
  const rules = rulesFor(documentKind);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: `What to check in a ${label.toLowerCase()}`,
          description: copy.standfirst,
          publisher: ORGANIZATION(),
          about: { '@type': 'Thing', name: label },
        }}
      />
      <JsonLd data={faqPage(copy.faq)} />

      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-accent)]">
        Document checks
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
        What to check in a {label.toLowerCase()}
      </h1>
      <p className="mt-4 max-w-2xl text-[var(--text-secondary)]">{copy.standfirst}</p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link
          href={`/document-ai?kind=${documentKind}`}
          className="inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-white hover:bg-accent-400"
        >
          Run these checks
        </Link>
        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
          <ShieldCheck aria-hidden className="size-4 text-[var(--text-accent)]" />
          Runs in your browser. Nothing is uploaded or stored.
        </span>
      </div>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">
          The {rules.length} checks we run, in full
        </h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Rules version {DOCUMENT_RULES_VERSION}. Published because a check you cannot see is a
          check you cannot argue with.
        </p>
        <ol className="mt-5 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {rules.map((rule) => (
            <li key={rule.id} className="flex gap-3 py-3">
              <code className="shrink-0 text-[11px] text-[var(--text-muted)]">{rule.id}</code>
              <span className="text-sm">{rule.title}</span>
            </li>
          ))}
        </ol>
      </section>

      <ToolFaq items={copy.faq} />

      <p className="mt-10 rounded-lg border-l-4 border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-3 text-sm text-[var(--text-secondary)]">
        Every finding is an observation and the question to put to your advocate, never a conclusion
        about title. There is no code path in this product that clears a document.
      </p>
    </div>
  );
}
