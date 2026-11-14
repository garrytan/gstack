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
import { extractReceipt, receiptRun, receiptRuns, RECEIPT_RUNS_KEPT, RUNS_FENCE, RUNS_RE, type ReceiptRun } from './ship-receipt';
import { FULL_PASS_CAP } from './review-depth';

export interface PrReviewHistory {
  /** /ship runs that reviewed (stubs and carries excluded). */
  runs: number;
  /** R51 rounds: full and scoped passes plus fix-checks, every run and started stub. */
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

const roundsOf = (l: ReceiptRun['review_loop']) => (l ? (l.rounds ?? (l.passes ?? 0) + (l.fix_checks ?? 0)) : 0);

/** Every entry the body records, oldest first: the runs block, then the current receipt. */
function entries(body: string): ReceiptRun[] {
  const current = extractReceipt(body).receipt;
  return [...receiptRuns(body), ...(current && typeof current.head === 'string' ? [receiptRun(current)] : [])];
}

export function prReviewHistory(body: string): PrReviewHistory {
  const all = entries(body);
  const reviewed = new Map<string, ReceiptRun>();
  const ordered: Array<ReceiptRun | string> = [];
  all.forEach((e, i) => {
    if (e.status || e.carry_kind || e.carried_from) { ordered.push(e); return; }
    const key = e.run ? `run:${e.run}` : `#${i}`;
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
  const kept = [...runs, JSON.parse(JSON.stringify(entry)) as ReceiptRun].slice(-RECEIPT_RUNS_KEPT);
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

export type Route = { route: 'first' | 'final' | 'read-only'; reason: string };

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
