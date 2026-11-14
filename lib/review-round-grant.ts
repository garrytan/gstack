/**
 * Review round grants (GST-2673, docs/review-policy.md#rounds-per-pull-request): a reason the lane or its Captain
 * records when a PR needs a review round its R51 count would not plan. kind=design-change: the design changed, so
 * this head gets a review round instead of the scoped re-check. kind=extra-round: one round past the PR's cap of two.
 * Either binds one head of one PR and is spent by the round it buys. It is recorded with gstack-approvals round-grant,
 * is never an owner ask and never a plan approval (lib/plan-record.ts NOT_PLAN_ROW). --by is recorded, not enforced.
 */
import { locate, readRecord, type ApprovalRow, type Env } from './approval-record';
import { GSTACK_ACTOR } from './ruled-notes';

export const ROUND_GRANT_KINDS = ['design-change', 'extra-round'] as const;
export type RoundGrantKind = (typeof ROUND_GRANT_KINDS)[number];
export interface ReviewRoundGrant { kind: RoundGrantKind; head: string; pr: number; by: string; reason: string; at: string; approval: string }

const SCOPE = /^review_round_grant ([0-9a-f]{40}) pr=([1-9]\d*) kind=(design-change|extra-round)$/;
const ASK = /^review_round_grant (design-change|extra-round) at ([0-9a-f]{40}) for pr ([1-9]\d*): (\S(?:.*\S)?)$/;
export const REVIEW_ROUND_GRANT_SCOPE = /^\s*review_round_grant\b/;

export const reviewRoundGrantRow = (head: string, pr: number, kind: RoundGrantKind, reason: string) =>
  ({ scope: `review_round_grant ${head} pr=${pr} kind=${kind}`, ask: `review_round_grant ${kind} at ${head} for pr ${pr}: ${reason}` });

export function reviewRoundGrants(rows: readonly ApprovalRow[]): ReviewRoundGrant[] {
  const out: ReviewRoundGrant[] = [];
  for (const r of rows) {
    const s = SCOPE.exec(r.scope), a = ASK.exec(r.ask);
    if (r.outcome !== 'approved' || !s || !a || GSTACK_ACTOR.test(r.by)) continue;
    if (a[1] !== s[3] || a[2] !== s[1] || a[3] !== s[2]) continue;
    out.push({ kind: s[3] as RoundGrantKind, head: s[1]!, pr: Number(s[2]), by: r.by, reason: a[4]!, at: r.recorded_at, approval: r.id });
  }
  return out;
}

export function readReviewRoundGrants(cwd: string, env: Env = process.env): ReviewRoundGrant[] {
  const loc = locate({ cwd, env });
  return 'code' in loc ? [] : reviewRoundGrants(readRecord(loc).rows);
}

/** The newest grant for this PR at exactly this head. */
export const grantAt = (grants: readonly ReviewRoundGrant[], pr: number, head: string) =>
  [...grants].reverse().find(g => g.pr === pr && g.head === head.toLowerCase());

/** The text after "Review round grant: " in the PR body. */
export const reviewRoundGrantText = (g: ReviewRoundGrant) =>
  `${g.kind} at ${g.head.slice(0, 12)} for PR #${g.pr} recorded by ${g.by} at ${g.at}: ${g.reason} (approval ${g.approval})`;
