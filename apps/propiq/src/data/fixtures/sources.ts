/**
 * DEVELOPMENT FIXTURE DATA — NOT LIVE MARKET INTELLIGENCE.
 *
 * Every record produced by this module carries `dataStatus: 'demo'` and every
 * surface that renders it must show the DEMO DATA badge. Developer, project and
 * transaction records here are invented. Locality names are real Bengaluru
 * localities so the demo is navigable, but every figure attached to them is
 * synthetic and must never be quoted as a market reading.
 *
 * The fixture adapter is refused in production by `getServerEnv()`.
 */

import { asId } from '@/domain/shared/types';
import type { EvidenceId } from '@/domain/shared/types';
import type { Evidence, PropertySource } from '@/domain/evidence/types';

export const FIXTURE_DISCLAIMER =
  'Development fixture. Figures are synthetic and do not describe any real property, ' +
  'project, developer or locality.';

/** All fixture evidence traces back to this single, obviously-labelled source. */
export const FIXTURE_SOURCE: PropertySource = {
  id: 'src-fixture',
  name: 'PropIQ development fixture',
  type: 'fixture',
  reference: 'src/data/fixtures',
  // Trust is deliberately below 1 so demo records never score as confidently
  // as a verified production record would.
  trust: 0.8,
};

let evidenceCounter = 0;

export const demoEvidence = (
  field: string,
  value: unknown,
  observedAt: string,
  confidence = 0.75,
): Evidence => {
  evidenceCounter += 1;
  return {
    id: asId<EvidenceId>(`ev-demo-${evidenceCounter}`),
    field,
    value,
    source: FIXTURE_SOURCE,
    observedAt,
    lastVerifiedAt: observedAt,
    dataStatus: 'demo',
    confidence,
    methodologyVersion: 'fixture-0.1.0',
    reviewState: 'unreviewed',
    note: FIXTURE_DISCLAIMER,
  };
};
