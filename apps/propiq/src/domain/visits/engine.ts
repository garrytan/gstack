/**
 * Visit summarisation and the visit → evidence loop.
 *
 * The loop is the point. A buyer who stands in a flat and sees a silt line on
 * the compound wall knows something the model does not, and that observation
 * should change the score rather than sit in a notes field. Answers against
 * checklist items that declare an `evidenceField` become `Evidence` records
 * with source type `survey` and a high trust weight — they are first-party.
 */

import type { EvidenceId, Instant, Unit01 } from '../shared/types';
import { asId, clamp01, round } from '../shared/types';
import type { Evidence, PropertySource } from '../evidence/types';
import type { Answer, SiteVisit, VisitObservation, VisitSummary } from './types';
import { CHECKLIST, checklistItem } from './checklist';

/**
 * First-party observation. Trust is high but not 1: a buyer is honest and
 * present, which beats a listing, but is not a surveyor with instruments.
 */
export const VISIT_SOURCE: PropertySource = {
  id: 'src-site-visit',
  name: 'Your site visit',
  type: 'survey',
  trust: 0.9,
};

const ANSWER_SCORE: Readonly<Record<Answer, number | undefined>> = {
  good: 1,
  acceptable: 0.6,
  concern: 0.1,
  // Unknown is not a score. It is excluded, exactly as a missing signal is
  // excluded from a pillar rather than counted as zero.
  unknown: undefined,
};

export const summariseVisit = (visit: SiteVisit): VisitSummary => {
  const answered = visit.observations.filter((o) => o.answer !== 'unknown');
  const concerns = visit.observations
    .filter((o) => o.answer === 'concern')
    .map((o) => checklistItem(o.itemId))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  const unknowns = visit.observations
    .filter((o) => o.answer === 'unknown')
    .map((o) => checklistItem(o.itemId))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  const scores = answered
    .map((o) => ANSWER_SCORE[o.answer])
    .filter((s): s is number => s !== undefined);

  return {
    visitId: visit.id,
    answered: answered.length,
    total: CHECKLIST.length,
    concerns,
    materialConcerns: concerns.filter((c) => c.material),
    unknowns,
    score:
      scores.length === 0
        ? undefined
        : clamp01(round(scores.reduce((a, b) => a + b, 0) / scores.length, 3)),
    completeness: clamp01(round(answered.length / CHECKLIST.length, 3)),
  };
};

/**
 * Turn visit observations into evidence.
 *
 * Only items that declare an `evidenceField` produce a record — the rest are
 * useful to the buyer but do not map onto anything the scoring engine reads,
 * and inventing a field for them would be worse than leaving them as notes.
 *
 * Confidence reflects the answer: a buyer reporting a concern they saw is more
 * reliable than one reporting that something looked fine, which is easy to say
 * without checking.
 */
export const visitToEvidence = (visit: SiteVisit, now: Instant): readonly Evidence[] => {
  if (visit.status !== 'completed') return [];

  const confidenceFor = (answer: Answer): Unit01 =>
    answer === 'concern' ? 0.9 : answer === 'good' ? 0.7 : answer === 'acceptable' ? 0.7 : 0;

  return visit.observations
    .filter((o) => o.answer !== 'unknown')
    .map((o) => ({ observation: o, item: checklistItem(o.itemId) }))
    .filter(
      (pair): pair is { observation: VisitObservation; item: NonNullable<typeof pair.item> } =>
        pair.item !== undefined && pair.item.evidenceField !== undefined,
    )
    .map(({ observation, item }) => ({
      id: asId<EvidenceId>(`ev-visit-${visit.id}-${item.id}`),
      field: item.evidenceField as string,
      value: observation.answer,
      source: VISIT_SOURCE,
      observedAt: visit.completedAt ?? now,
      lastVerifiedAt: visit.completedAt ?? now,
      dataStatus: 'verified' as const,
      confidence: confidenceFor(observation.answer),
      methodologyVersion: 'site-visit-0.1.0',
      reviewState: 'human_verified' as const,
      note: observation.note,
    }));
};

/**
 * Whether a completed visit should prompt a re-read of the property.
 *
 * A material concern is the trigger: those are the items whose `concern`
 * answer is serious enough to change a verdict, so seeing one means the
 * decision context on file is now out of date.
 */
export const visitChangesDecision = (summary: VisitSummary): boolean =>
  summary.materialConcerns.length > 0;
