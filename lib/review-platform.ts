/**
 * review-platform — the exact-head evidence that a platform review read a PR (design C6, FOUN-32 on founderstar#496).
 * Capy's automatic review posts a pull-request review by capy-ai[bot] whose commit_id is the head it read; that review's
 * id is the run id the plan's planned skip and the receipt's review_depth platform record. Anything else (no PR, no such
 * review, a review at another commit, one that requested changes or was dismissed, gh unavailable) is no evidence, and the
 * single light reader runs.
 */
import { spawnSync } from 'node:child_process';

export const PLATFORM_REVIEWER = 'capy-ai[bot]';
export interface PlatformReview { id: string; head: string; reviewer: string }

function gh(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** The newest submitted platform review of the PR (`pr`, or the current branch's) at `head`; `id`, when given, must be that review. */
export function platformReviewAt(root: string, head: string, o: { pr?: string; id?: string } = {}): { ok: true; review: PlatformReview } | { ok: false; reason: string } {
  const view = gh(root, ['pr', 'view', ...(o.pr ? [o.pr] : []), '--json', 'number']);
  const pr = view.ok ? (JSON.parse(view.out || '{}') as { number?: number }).number : undefined;
  if (!pr) return { ok: false, reason: o.pr ? `gh cannot read PR ${o.pr}` : 'no PR for this branch yet' };
  const list = gh(root, ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${pr}/reviews`]);
  if (!list.ok) return { ok: false, reason: `gh cannot list the reviews of PR #${pr}` };
  let reviews: Array<{ id?: number; user?: { login?: string }; commit_id?: string; state?: string }>;
  try { reviews = (JSON.parse(list.out) as unknown[]).flat() as typeof reviews; } catch { return { ok: false, reason: `PR #${pr}'s reviews are not JSON` }; }
  const at = reviews.filter(r => r.user?.login === PLATFORM_REVIEWER && r.state !== 'PENDING' && r.commit_id?.toLowerCase() === head.toLowerCase() && r.id !== undefined);
  const newest = at.at(-1);
  const hit = newest && (!o.id || String(newest.id) === o.id) && (newest.state === 'APPROVED' || newest.state === 'COMMENTED') ? newest : undefined;
  if (!hit) return { ok: false, reason: o.id ? `review ${o.id} on PR #${pr} is not a ${PLATFORM_REVIEWER} review at ${head.slice(0, 12)}` : `no ${PLATFORM_REVIEWER} review of PR #${pr} at ${head.slice(0, 12)}` };
  return { ok: true, review: { id: String(hit.id), head: head.toLowerCase(), reviewer: PLATFORM_REVIEWER } };
}
