import { describe, expect, it } from 'vitest';
import { CHECKLIST, checklistFor, checklistItem } from '@/domain/visits/checklist';
import { VISIT_CATEGORIES } from '@/domain/visits/types';
import type { SiteVisit, VisitObservation } from '@/domain/visits/types';
import { summariseVisit, visitChangesDecision, visitToEvidence } from '@/domain/visits/engine';
import { asId } from '@/domain/shared/types';
import type { PropertyId, UserId } from '@/domain/shared/types';
import { NOW } from './support/factories';

const visit = (
  observations: VisitObservation[],
  overrides: Partial<SiteVisit> = {},
): SiteVisit => ({
  id: 'visit-1',
  userId: asId<UserId>('u1'),
  propertyId: asId<PropertyId>('prop-1'),
  scheduledFor: '2026-05-20',
  status: 'completed',
  completedAt: '2026-05-20T10:00:00.000Z',
  observations,
  createdAt: NOW,
  ...overrides,
});

describe('checklist', () => {
  it('covers every declared category', () => {
    for (const category of VISIT_CATEGORIES) {
      expect(checklistFor(category).length, `no items for ${category}`).toBeGreaterThan(0);
    }
  });

  it('gives every item a reason it matters', () => {
    for (const item of CHECKLIST) {
      expect(item.why.length).toBeGreaterThan(30);
      expect(item.question.length).toBeGreaterThan(15);
    }
  });

  it('has unique ids', () => {
    expect(new Set(CHECKLIST.map((c) => c.id)).size).toBe(CHECKLIST.length);
  });

  it('marks the items that can change a verdict', () => {
    const material = CHECKLIST.filter((c) => c.material);
    expect(material.length).toBeGreaterThan(5);
    expect(material.length).toBeLessThan(CHECKLIST.length);
  });

  it('maps some items onto evidence fields the scoring engine reads', () => {
    const mapped = CHECKLIST.filter((c) => c.evidenceField);
    expect(mapped.length).toBeGreaterThan(3);
  });
});

describe('summariseVisit', () => {
  it('excludes unknowns from the score rather than counting them as zero', () => {
    const allGood = summariseVisit(visit([{ itemId: 'water.source', answer: 'good' }]));
    const goodPlusUnknown = summariseVisit(
      visit([
        { itemId: 'water.source', answer: 'good' },
        { itemId: 'power.backup', answer: 'unknown' },
      ]),
    );
    expect(allGood.score).toBe(1);
    expect(goodPlusUnknown.score).toBe(1);
    expect(goodPlusUnknown.unknowns).toHaveLength(1);
  });

  it('returns no score when nothing was answered', () => {
    expect(
      summariseVisit(visit([{ itemId: 'water.source', answer: 'unknown' }])).score,
    ).toBeUndefined();
  });

  it('separates material concerns from ordinary ones', () => {
    const summary = summariseVisit(
      visit([
        { itemId: 'construction.seepage', answer: 'concern' }, // material
        { itemId: 'amenities.lifts', answer: 'concern' }, // not material
      ]),
    );
    expect(summary.concerns).toHaveLength(2);
    expect(summary.materialConcerns).toHaveLength(1);
    expect(summary.materialConcerns[0]!.id).toBe('construction.seepage');
  });

  it('reports completeness against the full checklist', () => {
    const summary = summariseVisit(visit([{ itemId: 'water.source', answer: 'good' }]));
    expect(summary.total).toBe(CHECKLIST.length);
    expect(summary.completeness).toBeCloseTo(1 / CHECKLIST.length, 3);
  });

  it('scores a concern far below an acceptable answer', () => {
    const concern = summariseVisit(visit([{ itemId: 'water.source', answer: 'concern' }]));
    const acceptable = summariseVisit(visit([{ itemId: 'water.source', answer: 'acceptable' }]));
    expect(concern.score!).toBeLessThan(acceptable.score!);
  });
});

describe('visitToEvidence', () => {
  it('produces no evidence from an incomplete visit', () => {
    const scheduled = visit([{ itemId: 'water.source', answer: 'concern' }], {
      status: 'scheduled',
    });
    expect(visitToEvidence(scheduled, NOW)).toHaveLength(0);
  });

  it('produces evidence only for items that map onto an evidence field', () => {
    const evidence = visitToEvidence(
      visit([
        { itemId: 'water.source', answer: 'concern' }, // has evidenceField
        { itemId: 'amenities.lifts', answer: 'concern' }, // has none
      ]),
      NOW,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.field).toBe('locality.environment.waterStress');
  });

  it('marks first-party observations as verified survey evidence', () => {
    const evidence = visitToEvidence(visit([{ itemId: 'water.source', answer: 'concern' }]), NOW);
    expect(evidence[0]!.dataStatus).toBe('verified');
    expect(evidence[0]!.source.type).toBe('survey');
    expect(evidence[0]!.reviewState).toBe('human_verified');
  });

  it('trusts a reported concern more than a reported all-clear', () => {
    const concern = visitToEvidence(visit([{ itemId: 'water.source', answer: 'concern' }]), NOW);
    const good = visitToEvidence(visit([{ itemId: 'water.source', answer: 'good' }]), NOW);
    expect(concern[0]!.confidence).toBeGreaterThan(good[0]!.confidence);
  });

  it('drops unknown answers entirely', () => {
    expect(
      visitToEvidence(visit([{ itemId: 'water.source', answer: 'unknown' }]), NOW),
    ).toHaveLength(0);
  });

  it('dates evidence from the visit, not from now', () => {
    const evidence = visitToEvidence(visit([{ itemId: 'water.source', answer: 'good' }]), NOW);
    expect(evidence[0]!.observedAt).toBe('2026-05-20T10:00:00.000Z');
  });

  it('carries the buyer note onto the evidence record', () => {
    const evidence = visitToEvidence(
      visit([
        { itemId: 'water.source', answer: 'concern', note: 'Tankers twice a week in summer.' },
      ]),
      NOW,
    );
    expect(evidence[0]!.note).toContain('Tankers');
  });

  it('ignores an unknown checklist id rather than throwing', () => {
    expect(visitToEvidence(visit([{ itemId: 'nope.nope', answer: 'concern' }]), NOW)).toHaveLength(
      0,
    );
  });
});

describe('visitChangesDecision', () => {
  it('is true when a material concern was seen', () => {
    expect(
      visitChangesDecision(
        summariseVisit(visit([{ itemId: 'construction.seepage', answer: 'concern' }])),
      ),
    ).toBe(true);
  });

  it('is false for a non-material concern', () => {
    expect(
      visitChangesDecision(
        summariseVisit(visit([{ itemId: 'amenities.lifts', answer: 'concern' }])),
      ),
    ).toBe(false);
  });
});

describe('checklistItem', () => {
  it('returns undefined for an unknown id', () => {
    expect(checklistItem('nope')).toBeUndefined();
  });
});
