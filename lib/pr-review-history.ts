/**
 * pr-review-history — R51 per pull request (GST-2673, docs/review-policy.md#rounds-per-pull-request). gstack caps a
 * PR at two review rounds across every head, /ship run and reader, but each /ship run starts its own count, so a PR
 * pushed N times could get 2N rounds. The PR body already keeps every run's review loop (the receipt plus the
 * gstack-receipt-runs block, lib/ship-receipt.ts), on GitHub, where every host reads it the same way: this module adds
 * it up, records runs that stop before their receipt (a started stub), and says what review the next head gets. The
 * PR's last review before merge is a full review of its final head: a diff-only re-check caught 0 of 8 real faults
 * that full rounds had caught (GST-2673), so a re-check is advice only and never carries a receipt.
 */
import type { ShipReceipt } from './headless-artifacts';
import { withAgentNotes, splitAgentNotes } from './agent-notes';
import { extractReceipt, keptRuns, receiptRun, receiptRuns, RUNS_FENCE, RUNS_RE, type ReceiptRun } from './ship-receipt';
import { FULL_PASS_CAP } from './review-depth';
import type { ReviewRoundGrant } from './review-round-grant';

export interface PrReviewHistory {
  /** /ship runs that reviewed (stubs and carries excluded). */
  runs: number;
  /** R51 rounds: full and scoped passes, every run and started stub; a fix-check is no round (fix_checks counts it). */
  rounds: number;
  full: number;
  scoped: number;
  fix_checks: number;
  /** Scoped re-checks that carried the receipt to a new head before GST-2673 made them advice only. */
  rechecks: number;
  /** Runs that started and wrote no receipt yet. */
  stubs: number;
  heads: number;
  first_full: string | null;
  last_full: string | null;
  source: 'pr-body';
}

const roundsOf = (l: ReceiptRun['review_loop']) => l?.passes ?? 0;

/** Every entry the body records, oldest first: the runs block, then the current receipt. */
function entries(body: string): ReceiptRun[] {
  const current = extractReceipt(body).receipt;
  return [...receiptRuns(body), ...(current && typeof current.head === 'string' ? [receiptRun(current)] : [])];
}

/**
 * A run's stub and its own receipt at the same head count once (the newer entry stands); entries at different heads always count,
 * so a run id reused across /ship runs never hides their rounds (gstack-evals#406: three receipts of ship-406 read rounds=1).
 */
export function prReviewHistory(body: string): PrReviewHistory {
  const all = entries(body).filter(e => !e.mark);
  const reviewed = new Map<string, ReceiptRun>();
  const ordered: Array<ReceiptRun | string> = [];
  all.forEach((e, i) => {
    if (e.status === 'voided' || e.carry_kind || e.carried_from) { ordered.push(e); return; }
    const key = e.run ? `run:${e.run}@${e.head}` : `#${i}`;
    if (!reviewed.has(key)) ordered.push(key);
    reviewed.set(key, e);
  });
  const h: PrReviewHistory = { runs: 0, rounds: 0, full: 0, scoped: 0, fix_checks: 0, rechecks: 0, stubs: 0, heads: new Set(all.map(e => e.head)).size, first_full: null, last_full: null, source: 'pr-body' };
  for (const item of ordered) {
    const e = typeof item === 'string' ? reviewed.get(item)! : item;
    if (e.status === 'voided') continue;
    if (e.carry_kind === 'recheck') { h.rechecks++; continue; }
    if (e.carry_kind || e.carried_from) continue;
    const l = e.review_loop;
    const scoped = l?.scoped ?? 0, full = Math.max(0, (l?.passes ?? 0) - scoped);
    h.rounds += roundsOf(l); h.scoped += scoped; h.full += full; h.fix_checks += l?.fix_checks ?? 0;
    if (e.status === 'started') h.stubs++; else h.runs++;
    if (full > 0) { h.first_full ??= e.head; h.last_full = e.head; }
  }
  return h;
}

/**
 * Put one entry in the runs block: a stub replaces the same run's earlier stub, and any other entry is appended.
 * The receipt, when there is one, is unchanged; a body without one gets the block in its Agent notes section.
 */
export function placeRunEntry(body: string, entry: ReceiptRun): string {
  const runs = receiptRuns(body).filter(r => !(entry.status && r.status && r.run === entry.run));
  if (entry.mark && runs.some(r => JSON.stringify(r) === JSON.stringify(entry))) return body;
  const kept = keptRuns([...runs, JSON.parse(JSON.stringify(entry)) as ReceiptRun]);
  const block = '```' + RUNS_FENCE + '\n' + kept.map(r => JSON.stringify(r)).join('\n') + '\n```\n';
  if (RUNS_RE.test(body)) return body.replace(RUNS_RE, () => block);
  if (extractReceipt(body).found) {
    const end = /```gstack-ship-receipt[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*(?:\r?\n|$)/.exec(body)!;
    const at = end.index + end[0].length;
    return body.slice(0, at) + '\n' + block + body.slice(at);
  }
  const notes = (splitAgentNotes(body).notes ?? '').trim();
  return withAgentNotes(body.replace(/^\s+/, ''), (notes ? notes + '\n\n' : '') + block);
}

/** A started (or voided) stub for a /ship run that has not written its receipt yet. */
export const runStub = (o: { head: string; run: string; status: 'started' | 'voided'; loop: NonNullable<ShipReceipt['review_loop']> }): ReceiptRun =>
  ({ head: o.head, run: o.run, status: o.status, review_loop: o.loop });

/**
 * A stop record (GST-2968): the review a /ship run stopped on, written by gstack-ship-receipt stop when the plan prints NEXT: stop.
 * head is the commit that review read, tree its tree; the review row bound to it (lib/ship-stop.ts). A grant marker records
 * that a run claimed a round grant before dispatching the round it buys. Markers count no round and are never trimmed. Both carry
 * when they were recorded, so a granted fix-check orders stop, claim and row from the PR body alone (lib/fix-check-clearing.ts).
 */
export const stopMarker = (o: { head: string; tree: string; run: string; at?: string }): ReceiptRun => ({ head: o.head, run: o.run, mark: 'stop', tree: o.tree, at: o.at ?? new Date().toISOString() });
export const grantMarker = (o: { head: string; run: string; grant: string; at?: string }): ReceiptRun => ({ head: o.head, run: o.run, mark: 'grant', grant: o.grant, at: o.at ?? new Date().toISOString() });
/** gstack-ship-run abandon's entry (GST-3260): who ended a run that stopped working, and why, at the head it was abandoned on. */
export const abandonMarker = (o: { head: string; run: string; by: string; reason: string }): ReceiptRun => ({ head: o.head, run: o.run, mark: 'abandoned', by: o.by, reason: o.reason });
/** The newest receipt a run id already wrote, in the runs block or current: a run id names one /ship run (gstack-evals#406). */
export const receiptedRun = (body: string, run: string) => entries(body).filter(e => e.run === run && !e.mark && !e.status).at(-1);

/** The rows a /ship stop can follow: a full pass, a fix-check, or a Step 11 voice (#4591 stopped on its voices after a fix-check). */
const STOP_READERS = new Set(['review', 'review-fix-check', 'adversarial-review', 'codex-review']);

/**
 * The stop record for the newest via:ship reading row of this run (at or after since): a full pass, a fix-check or a Step 11 voice,
 * whichever read last, so the stop binds to the head that row read (#4591). Or why none binds: the row must be complete,
 * bound to one tree from start to end (verified, or incomplete because it stopped) that is its commit's own tree, read on a clean
 * worktree, and that commit must be HEAD or an ancestor of it. A read gstack can't tie to a commit gives a grant nothing to answer.
 */
export function stopFrom(rows: readonly Record<string, any>[], since: string, o: { treeOf: (commit: string) => string | undefined; onHead: (commit: string) => boolean }): { ok: true; head: string; tree: string } | { ok: false; why: string } {
  const sinceMs = Date.parse(since);
  const row = rows.filter(r => r && r.via === 'ship' && STOP_READERS.has(r.skill) && (!Number.isFinite(sinceMs) || Date.parse(r.timestamp) >= sinceMs)).at(-1);
  if (!row) return { ok: false, why: `no via:ship review row at or after ${since}` };
  const b = row.review_binding, head = typeof row.commit_full === 'string' ? row.commit_full.toLowerCase() : '';
  if (row.completed !== true) return { ok: false, why: 'the stopping review is not complete (a reader is missing)' };
  if (!b || (b.state !== 'verified' && b.state !== 'incomplete') || typeof row.tree !== 'string' || b.start_wtree !== row.tree || b.end_wtree !== row.tree || (row.wtree !== undefined && row.wtree !== row.tree)) return { ok: false, why: `the stopping review is not bound to one committed tree (binding ${b?.state ?? 'missing'})` };
  if (!/^[0-9a-f]{40}$/.test(head) || o.treeOf(head) !== row.tree) return { ok: false, why: `the stopping review's commit ${head.slice(0, 12) || 'missing'} does not hold the tree it read` };
  if (!o.onHead(head)) return { ok: false, why: `the stopping review's commit ${head.slice(0, 12)} is not HEAD or an ancestor of it` };
  return { ok: true, head, tree: row.tree };
}

export type GrantedStop = { ok: true; grant: ReviewRoundGrant; stop: ReceiptRun } | { ok: false; why: string };

/**
 * The fix-check grant that answers this PR's stop (GST-2968, GHOM-1): the newest stop record in the body, a fix-check grant naming
 * its run and head for this PR, not claimed by another run, and HEAD at or after the stop's head. A stop is stale once a later run
 * reviewed (a stub after it with a full pass, or a current receipt past its head): a grant then answers nothing.
 */
export function grantedStop(body: string, grants: readonly ReviewRoundGrant[], o: { pr: number; head: string; run?: string; isAncestor: (a: string, d: string) => boolean }): GrantedStop | null {
  const fixChecks = grants.filter(g => g.kind === 'fix-check' && g.pr === o.pr);
  if (!fixChecks.length) return null;
  const runs = receiptRuns(body);
  const at = runs.map(r => r.mark).lastIndexOf('stop');
  if (at < 0) return { ok: false, why: `no stop record in the PR body for grant ${fixChecks.at(-1)!.approval}; a fix-check grant answers the stop gstack-ship-receipt stop recorded` };
  const stop = runs[at]!;
  const current = extractReceipt(body).receipt;
  const later = runs.slice(at + 1).find(r => !r.mark && r.run !== stop.run && (r.review_loop?.passes ?? 0) > 0);
  if (later || (current && typeof current.head === 'string' && current.head !== stop.head && o.isAncestor(stop.head, current.head))) return { ok: false, why: `the stop at ${stop.head.slice(0, 12)} (run ${stop.run}) is stale: run ${later?.run ?? current?.run} reviewed after it` };
  const g = [...fixChecks].reverse().find(x => x.head === stop.head && x.stop_run === stop.run);
  if (!g) return { ok: false, why: `no fix-check grant names the newest stop (run ${stop.run} at ${stop.head.slice(0, 12)}): record one with gstack-approvals round-grant --kind fix-check --head ${stop.head} --stop-run ${stop.run}` };
  const claimed = runs.find(r => r.mark === 'grant' && r.grant === g.approval && r.run !== o.run);
  if (claimed) return { ok: false, why: `grant ${g.approval} was claimed by run ${claimed.run}: a grant buys one round` };
  if (!o.isAncestor(stop.head, o.head)) return { ok: false, why: `HEAD ${o.head.slice(0, 12)} does not contain the stop's head ${stop.head.slice(0, 12)}: a head move voids grant ${g.approval}` };
  return { ok: true, grant: g, stop };
}

export type Route = { route: 'first' | 'final' | 'read-only' | 'fix-check'; reason: string };

/**
 * What review a head of the PR gets when carry can't keep its receipt (the PR's own lines changed; a head that only
 * merges in the base keeps it). Before any full round: the first review, as today. Below the cap: a fresh full review
 * of this head, the PR's last before merge. At the cap: one read-only full review of the final head, with no fix round,
 * whose blocker goes to the lane's Captain as a decision; an extra-round grant at this head buys a fix round instead.
 * A scoped re-check is advice only and never stands in (GST-2673).
 */
export function reviewRoute(h: Pick<PrReviewHistory, 'full'>, o: { grant?: string } = {}): Route {
  if (!h.full) return { route: 'first', reason: 'no full review round on this PR yet' };
  if (h.full < FULL_PASS_CAP) return { route: 'final', reason: `the PR had ${h.full} full review round${h.full === 1 ? '' : 's'}; this head gets a fresh full review, the PR's round ${h.full + 1} of ${FULL_PASS_CAP} and its last before merge (R51)` };
  if (o.grant && h.full === FULL_PASS_CAP) return { route: 'final', reason: `the PR had ${h.full} full review rounds; round grant ${o.grant} buys one more at this head, with its fix round` };
  return { route: 'read-only', reason: `the PR had ${h.full} full review rounds; this head gets one read-only full review: no fix round, a blocker goes to the lane's Captain as a decision, and the count does not reopen (R51)` };
}

const s12 = (s: string | null) => (s ? s.slice(0, 12) : 'none');

export function historyLine(pr: string, h: PrReviewHistory): string {
  return `PR_REVIEW_HISTORY: pr=#${pr} rounds=${h.rounds} cap=${FULL_PASS_CAP} full=${h.full} scoped=${h.scoped} fix_checks=${h.fix_checks} rechecks=${h.rechecks} runs=${h.runs} stubs=${h.stubs} heads_reviewed=${h.heads} first_full=${s12(h.first_full)} last_full=${s12(h.last_full)} source=${h.source}`;
}
