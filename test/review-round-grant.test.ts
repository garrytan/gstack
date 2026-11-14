/**
 * GST-2673: a review round grant is a reason the lane or its Captain records in the approvals path; it is never an
 * owner ask, never a plan approval, and it binds one head of one PR.
 */
import { describe, expect, test } from 'bun:test';
import { grantAt, reviewRoundGrantRow, reviewRoundGrants, reviewRoundGrantText, REVIEW_ROUND_GRANT_SCOPE } from '../lib/review-round-grant';
import type { ApprovalRow } from '../lib/approval-record';

const head = '1'.repeat(40);
const row = (o: Partial<ApprovalRow>): ApprovalRow => ({ id: 'a-000000000001', date: '2026-11-14', recorded_at: '2026-11-14T00:00:00Z', words: 'w', by: 'captain:GStack Minder', pending: 'none', outcome: 'approved', source: 'manual', branch: 'b', ...reviewRoundGrantRow(head, 12, 'extra-round', 'the design changed after round 2'), ...o } as ApprovalRow);

describe('review round grants', () => {
  test('the row round-trips with kind, head, PR and reason', () => {
    const [g] = reviewRoundGrants([row({})]);
    expect(g).toMatchObject({ kind: 'extra-round', head, pr: 12, reason: 'the design changed after round 2', approval: 'a-000000000001' });
    expect(REVIEW_ROUND_GRANT_SCOPE.test(row({}).scope)).toBe(true);
    expect(reviewRoundGrantText(g!)).toContain('extra-round at 111111111111 for PR #12');
  });

  test('only an approved row that gstack did not write counts, and it binds only its head and PR', () => {
    expect(reviewRoundGrants([row({ outcome: 'pending' as any })])).toEqual([]);
    expect(reviewRoundGrants([row({ by: 'gstack' })])).toEqual([]);
    const gs = reviewRoundGrants([row({})]);
    expect(grantAt(gs, 12, head)).toBeDefined();
    expect(grantAt(gs, 13, head)).toBeUndefined();
    expect(grantAt(gs, 12, '2'.repeat(40))).toBeUndefined();
  });

  test('a mismatched ask and scope is no grant', () => {
    expect(reviewRoundGrants([row({ ask: 'review_round_grant extra-round at ' + '2'.repeat(40) + ' for pr 12: x' })])).toEqual([]);
  });
});
