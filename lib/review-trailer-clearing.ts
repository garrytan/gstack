/**
 * review-trailer-clearing: when an open blocker closes without an owner ruling (#4597, docs/review-policy.md#what-closes-a-finding).
 * A later complete full review of the branch read it clean after a fix commit that either carries the finding's Review-Finding trailer
 * (clearByTrailer, cleared_by_trailer) or, with no trailer, changed the finding's file after the finding was raised (clearByReview,
 * cleared_by_review, GSKI-1 #4); gstack-ship-receipt write closes exactly those blockers and records them. Every
 * input is a record gstack's tools wrote (the review log and the branch's commits); the agent's --review-loop file only lists
 * which blockers are open. The granted fix-check route that shared this module was removed in GST-3562 part 4.
 */
import { spawnSync } from './spawn-sync';
import { parseFixTrailers, rowTime } from './review-scope';
import { isSecurityFinding } from './security-findings';

type Row = Record<string, any>;
/** One entry of the loop summary's `open` list: a ledger id or fingerprint, or both. */
export type OpenBlocker = string | { id: string; fingerprint: string };
export interface TrailerClearing { id: string; commit: string; review: string }

const SHA = /^[0-9a-f]{40}$/;
const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout ?? '' : null;
};
const ancestor = (cwd: string, a: string, d: string) => a === d || git(cwd, ['merge-base', '--is-ancestor', a, d]) !== null;
const treeOf = (cwd: string, c: string) => git(cwd, ['rev-parse', '--verify', '--quiet', `${c}^{tree}`])?.trim();
const findingsOf = (r: Row): Row[] => (Array.isArray(r?.findings) ? r.findings.filter((f: unknown) => !!f && typeof f === 'object') : []);
const nameOf = (b: OpenBlocker) => (typeof b === 'string' ? b : b.id);

/**
 * The later complete full review that read `fix` clean: a `review` row of /ship (not a fix-range or scoped repeat) that started after
 * `after`, finished and converged, bound to its own committed tree on this branch with `fix` inside its range and its commit, and
 * left nothing open (its status, findings_open from a findings file, an inline open finding).
 */
function cleanReviewOf(cwd: string, rows: readonly Row[], after: number, fix: string, head: string): Row | undefined {
  const inRange = (from: unknown) => from == null || (typeof from === 'string' && (b => !!b && !ancestor(cwd, fix, b))(git(cwd, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`])?.trim()));
  return rows.find(r => r?.skill === 'review' && r.via === 'ship' && r.completed === true && r.scope !== 'fix-range' && r.scope !== 'scoped' && rowTime(r) > after
    && r.converged === true && r.review_binding?.state === 'verified' && inRange(r.range_base) && typeof r.tree === 'string' && r.review_binding.start_wtree === r.tree && r.review_binding.end_wtree === r.tree
    && SHA.test(String(r.commit_full)) && treeOf(cwd, r.commit_full) === r.tree && ancestor(cwd, fix, r.commit_full) && ancestor(cwd, r.commit_full, head)
    && r.status !== 'issues_found' && r.status !== 'issues_open' && Number(r.findings_open ?? 0) === 0 && !findingsOf(r).some(f => f.action === 'open'));
}

/** The rows that hold blocker `b` open, each with its finding. */
const raisedBy = (rows: readonly Row[], b: OpenBlocker) => {
  const id = nameOf(b), fp = typeof b === 'string' ? b : b.fingerprint;
  return rows.flatMap(r => findingsOf(r).filter(f => f.action === 'open' && (f.ledger_id === id || (f.ledger_id === undefined && f.fingerprint === fp))).map(f => ({ r, f })));
};

/**
 * The #4597 route: an open blocker closes when a branch commit carries its Review-Finding trailer (its exact ledger id, or its
 * fingerprint when no other open blocker shares it) and a later complete full review (cleanReviewOf) holding that commit read it
 * clean. Gate findings never close this way.
 */
export function clearByTrailer(cwd: string, o: { head: string; baseRef: string; rows: readonly Row[]; open: readonly OpenBlocker[] }): TrailerClearing[] {
  const log = git(cwd, ['log', '--no-merges', '--format=%H%x00%(trailers:key=Review-Finding,valueonly,separator=%x1f)%x1e', `${o.baseRef}..${o.head}`]);
  const trailers = (log ?? '').split('\x1e').flatMap(rec => { const [sha, values] = rec.trim().split('\0'); return sha && values ? parseFixTrailers(sha, values.split('\x1f').map(v => v.trim()).filter(Boolean)) : []; });
  return o.open.flatMap(b => {
    const id = nameOf(b), fp = typeof b === 'string' ? b : b.fingerprint;
    const raised = raisedBy(o.rows, b);
    const alone = o.open.filter(c => (typeof c === 'string' ? c : c.fingerprint) === fp).length === 1;
    const t = trailers.find(x => x.finding === id || (alone && x.finding === fp));
    if (!t || !raised.length || raised.some(x => x.f.gate !== undefined) || isSecurityFinding(t.finding)) return [];
    const review = cleanReviewOf(cwd, o.rows, Math.max(...raised.map(x => rowTime(x.r))), t.commit, o.head);
    return review ? [{ id, commit: t.commit, review: review.commit_full as string }] : [];
  });
}

/**
 * The GSKI-1 #4 route, for a fix commit with no trailer: an open blocker closes when a commit made after every row that holds it open
 * (not an ancestor of any of their commits) changed the finding's own file, and a later complete full review (cleanReviewOf, the
 * read-only final review included) holding that commit read the whole branch clean. The invariant that keeps a real blocker open: a
 * finding with no file (a fingerprint without path:line:category and no path field), a raising row with no commit, a gate or
 * security-class finding, a change to its file made only before it was raised, and a later round that left anything open never close.
 */
export function clearByReview(cwd: string, o: { head: string; baseRef: string; rows: readonly Row[]; open: readonly OpenBlocker[] }): TrailerClearing[] {
  return o.open.flatMap(b => {
    const id = nameOf(b), fp = typeof b === 'string' ? b : b.fingerprint;
    const raised = raisedBy(o.rows, b);
    if (!raised.length || raised.some(x => x.f.gate !== undefined || isSecurityFinding(x.f)) || isSecurityFinding(fp) || isSecurityFinding(id)) return [];
    const files = new Set(raised.map(x => typeof x.f.path === 'string' && x.f.path ? x.f.path.replace(/^\.\//, '') : /^(.+):\d*:[^:\s]+$/.exec(String(x.f.fingerprint ?? ''))?.[1]));
    const file = files.size === 1 ? [...files][0] : undefined;
    const at = raised.map(x => String(x.r.commit_full));
    if (!file || file === '?' || !at.every(c => SHA.test(c))) return [];
    const after = Math.max(...raised.map(x => rowTime(x.r)));
    const touched = (git(cwd, ['--literal-pathspecs', 'log', '--no-merges', '--format=%H', `${o.baseRef}..${o.head}`, '--', file]) ?? '').split('\n').map(c => c.trim()).filter(c => SHA.test(c));
    for (const fix of touched.filter(c => at.every(a => !ancestor(cwd, c, a)))) {
      const review = cleanReviewOf(cwd, o.rows, after, fix, o.head);
      if (review) return [{ id, commit: fix, review: review.commit_full as string }];
    }
    return [];
  });
}
