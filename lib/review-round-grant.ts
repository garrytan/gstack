/**
 * Review round grants (GST-2673, docs/review-policy.md#rounds-per-pull-request): a reason the lane or its Captain
 * records when a PR needs a review round its R51 count would not plan. kind=extra-round: one round, with its fix
 * round, past the PR's cap of two. It binds one head of one PR and is spent by the round it buys. It is recorded with gstack-approvals round-grant,
 * is never an owner ask and never a plan approval (lib/plan-record.ts NOT_PLAN_ROW). --by is recorded, not enforced.
 */
import { spawnSync } from 'node:child_process';
import { locate, readRecord, type ApprovalRow, type Env } from './approval-record';
import { GSTACK_ACTOR } from './ruled-notes';

export const ROUND_GRANT_KINDS = ['extra-round'] as const;
export type RoundGrantKind = (typeof ROUND_GRANT_KINDS)[number];
export interface ReviewRoundGrant { kind: RoundGrantKind; head: string; pr: number; by: string; reason: string; at: string; approval: string }

const SCOPE = /^review_round_grant ([0-9a-f]{40}) pr=([1-9]\d*) kind=(extra-round)$/;
const ASK = /^review_round_grant (extra-round) at ([0-9a-f]{40}) for pr ([1-9]\d*): (\S(?:.*\S)?)$/;
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

/**
 * The newest grant for this PR at this head, or at a head this one only merges the base into or out of (GST-2968): one is
 * the other's ancestor and the PR's own added and removed lines against baseRef are byte-identical at both. Preflight
 * merges the base before the review, so the stop head a grant names and the head the next run reads can differ that way.
 */
export function grantFor(repoRoot: string, grants: readonly ReviewRoundGrant[], pr: number, head: string, baseRef?: string): ReviewRoundGrant | undefined {
  const exact = grantAt(grants, pr, head);
  if (exact || !baseRef) return exact;
  return [...grants].reverse().find(g => g.pr === pr && ownLinesSame(repoRoot, baseRef, g.head, head.toLowerCase()));
}

/** Whether a and b are on one line of history and carry byte-identical own lines against baseRef (a zero-context patch-id). */
export function ownLinesSame(repoRoot: string, baseRef: string, a: string, b: string): boolean {
  const git = (args: string[], input?: string) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repoRoot, encoding: 'utf8', input, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  if (git(['merge-base', '--is-ancestor', a, b]).status !== 0 && git(['merge-base', '--is-ancestor', b, a]).status !== 0) return false;
  const own = (c: string) => {
    const fork = git(['merge-base', baseRef, c]);
    if (fork.status !== 0) return null;
    const d = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', '-U0', fork.stdout.trim(), c]);
    if (d.status !== 0 || !d.stdout.trim()) return null;
    const id = git(['patch-id', '--verbatim'], d.stdout);
    return id.status === 0 ? id.stdout.trim().split(/\s+/)[0] || null : null;
  };
  const x = own(a);
  return x !== null && x === own(b);
}

/** The text after "Review round grant: " in the PR body. */
export const reviewRoundGrantText = (g: ReviewRoundGrant) =>
  `${g.kind} at ${g.head.slice(0, 12)} for PR #${g.pr} recorded by ${g.by} at ${g.at}: ${g.reason} (approval ${g.approval})`;
