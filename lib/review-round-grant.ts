/**
 * Review round grants (GST-2673, docs/review-policy.md#rounds-per-pull-request): a reason the lane or its Captain
 * records when a PR needs a review round its R51 count would not plan. kind=extra-round: one round, with its fix
 * round, past the PR's cap of two, at a head no review has stopped at. kind=fix-check (GST-2968): the fix round of a
 * review that already stopped, naming that stop (its run and head, lib/pr-review-history.ts stopRecord) and the
 * findings it is for. Each binds one head of one PR and is spent by the run that claims it. It is recorded with
 * gstack-approvals round-grant, is never an owner ask and never a plan approval (lib/plan-record.ts NOT_PLAN_ROW).
 * --by is recorded, not enforced.
 */
import { spawnSync } from './spawn-sync';
import { locate, readRecord, type ApprovalRow, type Env } from './approval-record';
import { isGstackActorName } from './ruled-notes';

export const ROUND_GRANT_KINDS = ['extra-round', 'fix-check'] as const;
export type RoundGrantKind = (typeof ROUND_GRANT_KINDS)[number];
/** stop_run and findings: a fix-check grant's stop (the run that stopped at head) and the finding ids it is for. */
export interface ReviewRoundGrant { kind: RoundGrantKind; head: string; pr: number; by: string; reason: string; at: string; approval: string; stop_run?: string; findings?: string[] }

export const STOP_RUN = /^[\w.:-]{1,120}$/;
export const FINDING_ID = /^[\w.:/#@-]{1,200}$/;
const SCOPE = /^review_round_grant ([0-9a-f]{40}) pr=([1-9]\d*) kind=(extra-round|fix-check)(?: stop=(\S+) findings=(\S+))?$/;
const ASK = /^review_round_grant (extra-round|fix-check) at ([0-9a-f]{40}) for pr ([1-9]\d*): (\S(?:.*\S)?)$/;
export const REVIEW_ROUND_GRANT_SCOPE = /^\s*review_round_grant\b/;

export const reviewRoundGrantRow = (head: string, pr: number, kind: RoundGrantKind, reason: string, stop?: { run: string; findings: readonly string[] }) =>
  ({ scope: `review_round_grant ${head} pr=${pr} kind=${kind}${stop ? ` stop=${stop.run} findings=${stop.findings.join(',')}` : ''}`, ask: `review_round_grant ${kind} at ${head} for pr ${pr}: ${reason}` });

export function reviewRoundGrants(rows: readonly ApprovalRow[]): ReviewRoundGrant[] {
  const out: ReviewRoundGrant[] = [];
  for (const r of rows) {
    const s = SCOPE.exec(r.scope), a = ASK.exec(r.ask);
    if (r.outcome !== 'approved' || !s || !a || isGstackActorName(r.by)) continue;
    if (a[1] !== s[3] || a[2] !== s[1] || a[3] !== s[2]) continue;
    const findings = s[5]?.split(',');
    if ((s[3] === 'fix-check') !== (s[4] !== undefined) || (s[4] !== undefined && (!STOP_RUN.test(s[4]) || !findings!.every(f => FINDING_ID.test(f))))) continue;
    out.push({ kind: s[3] as RoundGrantKind, head: s[1]!, pr: Number(s[2]), by: r.by, reason: a[4]!, at: r.recorded_at, approval: r.id, ...(s[4] ? { stop_run: s[4], findings } : {}) });
  }
  return out;
}

export function readReviewRoundGrants(cwd: string, env: Env = process.env): ReviewRoundGrant[] {
  const loc = locate({ cwd, env });
  return 'code' in loc ? [] : reviewRoundGrants(readRecord(loc).rows);
}

/** The newest extra-round grant for this PR at exactly this head (a fix-check grant answers a stop instead: lib/pr-review-history.ts grantedStop). */
export const grantAt = (grants: readonly ReviewRoundGrant[], pr: number, head: string) =>
  [...grants].reverse().find(g => g.kind === 'extra-round' && g.pr === pr && g.head === head.toLowerCase());

/**
 * The newest extra-round grant for this PR at this head, or at a head this one only merges the base into or out of (GST-2968): one is
 * the other's ancestor and the PR's own added and removed lines against baseRef are byte-identical, in the same places, at both.
 * Preflight merges the base before the review, so the head a grant names and the head the next run reads can differ that way.
 */
export function grantFor(repoRoot: string, grants: readonly ReviewRoundGrant[], pr: number, head: string, baseRef?: string): ReviewRoundGrant | undefined {
  const exact = grantAt(grants, pr, head);
  if (exact || !baseRef) return exact;
  return [...grants].reverse().find(g => g.kind === 'extra-round' && g.pr === pr && ownLinesSame(repoRoot, baseRef, g.head, head.toLowerCase()));
}

interface Hunk { path: string; start: number; len: number; added: number }

/** A zero-context diff's hunks: the file (its old side, or its new side when created), the old-side start and length, and the added length. */
function hunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let minus = '', path = '';
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) minus = l.slice(4);
    else if (l.startsWith('+++ ')) path = minus === '/dev/null' ? l.slice(4) : minus;
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (m) out.push({ path, start: +m[1]!, len: m[2] === undefined ? 1 : +m[2], added: m[3] === undefined ? 1 : +m[3] });
  }
  return out;
}

/**
 * The old-side line own hunk h starts at once the base's hunks have moved its file, or null when the base edited a line h changes or
 * inserted inside or right next to h, so its place can't be carried over. Spans are in half-line steps: 2n is line n, 2n+1 the gap after it.
 */
function carried(base: readonly Hunk[], h: Hunk): number | null {
  const span = (x: Hunk, pad: number): [number, number] => x.len ? [2 * x.start - pad, 2 * (x.start + x.len - 1) + pad] : [2 * x.start + 1 - pad, 2 * x.start + 1 + pad];
  const [lo, hi] = span(h, 1);
  let shift = 0;
  for (const b of base.filter(x => x.path === h.path)) {
    const [blo, bhi] = span(b, 0);
    if (blo <= hi && lo <= bhi) return null;
    if (bhi < lo) shift += b.added - b.len;
  }
  return h.start + shift;
}

/**
 * Whether a and b are on one line of history and carry byte-identical own lines against baseRef at the same places: equal
 * zero-context patch-ids, and each own hunk of a, carried through the base's changes between the two forks, starts where b's does.
 * Moving a line to another place in the same file changes no patch-id, so the places are compared too.
 */
export function ownLinesSame(repoRoot: string, baseRef: string, a: string, b: string): boolean {
  const git = (args: string[], input?: string) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repoRoot, encoding: 'utf8', input, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  if (git(['merge-base', '--is-ancestor', a, b]).status !== 0 && git(['merge-base', '--is-ancestor', b, a]).status !== 0) return false;
  const fork = (c: string) => { const f = git(['merge-base', baseRef, c]); return f.status === 0 ? f.stdout.trim() : null; };
  const diff = (x: string, y: string) => { const d = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', '-U0', x, y]); return d.status === 0 ? d.stdout : null; };
  const id = (d: string) => { const p = git(['patch-id', '--verbatim'], d); return p.status === 0 ? p.stdout.trim().split(/\s+/)[0] || null : null; };
  const fa = fork(a), fb = fork(b);
  if (!fa || !fb) return false;
  const da = diff(fa, a), db = diff(fb, b), moved = fa === fb ? '' : diff(fa, fb);
  if (!da?.trim() || !db?.trim() || moved === null) return false;
  const x = id(da);
  if (x === null || x !== id(db)) return false;
  const base = hunks(moved), there = hunks(db), here = hunks(da);
  return here.length === there.length && here.every((h, i) => h.path === there[i]!.path && h.len === there[i]!.len && carried(base, h) === there[i]!.start);
}

/** The text after "Review round grant: " in the PR body. */
export const reviewRoundGrantText = (g: ReviewRoundGrant) =>
  `${g.kind} at ${g.head.slice(0, 12)} for PR #${g.pr}${g.stop_run ? ` (stop ${g.stop_run}, findings ${g.findings!.join(', ')})` : ''} recorded by ${g.by} at ${g.at}: ${g.reason} (approval ${g.approval})`;
