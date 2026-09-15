/**
 * JSON-LD.
 *
 * Structured data is how a machine reads a claim without guessing. That
 * matters more here than for most products: a growing share of the questions
 * this product answers are asked of an AI engine rather than typed into a
 * search box, and an engine cites what it can parse, date and attribute.
 *
 * Everything emitted here describes the page itself — what the tool computes,
 * what the methodology says, who published it and when. None of it asserts a
 * property fact, so none of it can carry a data-status problem.
 */

import { clientEnv } from '@/lib/env';

const base = (): string => clientEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');

export const ORGANIZATION = () => ({
  '@type': 'Organization',
  '@id': `${base()}/#organization`,
  name: 'PropIQ by CiteRank AI',
  url: base(),
  description:
    'Property decision intelligence. Twelve-pillar scoring with a published formula, ' +
    'evidence-dated inputs and a 95% confidence band on every score.',
});

/** A free tool: what it computes, for whom, at no cost. */
export const webApplication = (input: {
  name: string;
  description: string;
  path: string;
  features: readonly string[];
}) => ({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: input.name,
  url: `${base()}${input.path}`,
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Any',
  browserRequirements: 'Runs entirely in the browser. No account, no upload.',
  description: input.description,
  featureList: [...input.features],
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
  publisher: ORGANIZATION(),
});

/** Questions with answers, which is the shape an answer engine can quote. */
export const faqPage = (qa: ReadonlyArray<{ question: string; answer: string }>) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: qa.map((x) => ({
    '@type': 'Question',
    name: x.question,
    acceptedAnswer: { '@type': 'Answer', text: x.answer },
  })),
});

/** A term this product defines and publishes, so it can be cited as defined. */
export const definedTerm = (input: {
  name: string;
  description: string;
  path: string;
  version: string;
}) => ({
  '@context': 'https://schema.org',
  '@type': 'DefinedTerm',
  name: input.name,
  description: input.description,
  url: `${base()}${input.path}`,
  inDefinedTermSet: {
    '@type': 'DefinedTermSet',
    name: `PropIQ scoring methodology v${input.version}`,
    url: `${base()}/methodology`,
  },
  publisher: ORGANIZATION(),
});

/**
 * Render a JSON-LD block.
 *
 * The payload is assembled by this module from literals, never from user
 * input or from a property record, so there is no untrusted string reaching
 * the script tag.
 */
export const JsonLd = ({ data }: { data: object }) => (
  <script
    type="application/ld+json"
    dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
  />
);
