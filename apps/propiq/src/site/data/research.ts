/**
 * Research index.
 *
 * The engine has no notion of an article, so these are authored. They are
 * therefore marked `demo` and every one of them links to a page that exists —
 * the methodology, the data-source register, the free tools — rather than to
 * a report that has not been written. A card promising a report we cannot
 * open is the marketing version of a fabricated number.
 */

import type { ResearchArticle } from '@/site/types';

export const RESEARCH: readonly ResearchArticle[] = [
  {
    slug: 'how-the-score-works',
    kicker: 'Scoring framework',
    title: 'What a PropIQ Score is made of',
    standfirst:
      'Twelve pillars, the weights for each buyer type, how a missing signal is dropped rather ' +
      'than scored zero, and why every score carries a 95% band.',
    readMinutes: 8,
    published: 'Methodology v0.1.0',
    href: '/methodology',
    dataStatus: 'demo',
  },
  {
    slug: 'what-backs-a-number',
    kicker: 'Provenance',
    title: 'Where every figure comes from',
    standfirst:
      'The source classes behind an estimate, the half-life each one decays on, and what this ' +
      'deployment is and is not currently connected to.',
    readMinutes: 6,
    published: 'Live register',
    href: '/data-sources',
    dataStatus: 'demo',
  },
  {
    slug: 'carpet-area',
    kicker: 'Buyer guide',
    title: 'The loading nobody quotes you',
    standfirst:
      'You live on carpet area and pay for super built-up. There is no statutory ceiling on the ' +
      'gap, so two flats at the same advertised rate can differ by a fifth in usable space.',
    readMinutes: 5,
    published: 'Free tool',
    href: '/tools/carpet-area',
    dataStatus: 'demo',
  },
];
