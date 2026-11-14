/**
 * pr-review-history — R51 per pull request (GST-2673, docs/review-policy.md#rounds-per-pull-request). gstack caps a
 * PR at two review rounds across every head, /ship run and reader, but each /ship run starts its own count, so a PR
 * pushed N times could get 2N rounds. The PR body already keeps every run's review loop (the receipt plus the
 * gstack-receipt-runs block, lib/ship-receipt.ts), on GitHub, where every host reads it the same way: this module adds
 * it up, records runs that stop before their receipt (a started stub) and re-checks that found a blocker, and says
 * whether the next head takes the scoped re-check or a review round. Preflight is the only router to the re-check.
 */
import { spawnSync } from 'node:child_process';
import type { ShipReceipt } from './headless-artifacts';
import { withAgentNotes, splitAgentNotes } from './agent-notes';
import { CARRY_METADATA_GLOBS, CARRY_TEST_GLOBS, extractReceipt, receiptRun, receiptRuns, RECEIPT_RUNS_KEPT, RUNS_FENCE, RUNS_RE, type ReceiptRun } from './ship-receipt';
import { matchesAny } from './ship-policy';
import { FULL_PASS_CAP } from './review-depth';

/**
 * The product lines a PR may change after its first full round before its next head gets a fresh review round
 * instead of the scoped re-check, even when each step was small. A starting value; the free replay calibrates it.
 */
export const PR_DRIFT_LINES = 400;

export interface PrReviewHistory {
  /** /ship runs that reviewed (stubs and carries excluded). */
  runs: number;
  /** R51 rounds: full and scoped passes plus fix-checks, every run and started stub. */
  rounds: number;
  full: number;
  scoped: number;
  fix_checks: number;
  /** Clean scoped re-checks that carried the receipt to a new head. */
  rechecks: number;
  /** Re-checks that found a blocker since the newest full round. */
  recheck_blocked: number;
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
  const h: PrReviewHistory = { runs: 0, rounds: 0, full: 0, scoped: 0, fix_checks: 0, rechecks: 0, recheck_blocked: 0, stubs: 0, heads: new Set(all.map(e => e.head)).size, first_full: null, last_full: null, source: 'pr-body' };
  for (const item of ordered) {
    const e = typeof item === 'string' ? reviewed.get(item)! : item;
    if (e.status === 'voided') continue;
    if (e.carry_kind === 'recheck-blocked') continue;
    if (e.carry_kind === 'recheck') { h.rechecks++; continue; }
    if (e.carry_kind || e.carried_from) continue;
    const l = e.review_loop;
    const scoped = l?.scoped ?? 0, full = Math.max(0, (l?.passes ?? 0) - scoped);
    h.rounds += roundsOf(l); h.scoped += scoped; h.full += full; h.fix_checks += l?.fix_checks ?? 0;
    if (e.status === 'started') h.stubs++; else h.runs++;
    if (full > 0) { h.first_full ??= e.head; h.last_full = e.head; }
  }
  // A re-check reads from the receipt's head, and carries keep the reviewed head as carried_from, so the blocked
  // re-checks since the newest full round are the ones from its head or from a head a re-check carried it to.
  const since = new Set([h.last_full, ...all.filter(e => e.carried_from && e.carried_from === h.last_full).map(e => e.head)]);
  h.recheck_blocked = all.filter(e => e.carry_kind === 'recheck-blocked' && (h.last_full === null || since.has(e.carried_from ?? null))).length;
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

/** Lines changed by the branch's own non-merge commits (numstat), tests, release metadata and binaries left out. */
export function driftFromNumstat(numstat: string): number {
  let n = 0;
  for (const line of numstat.split('\n')) {
    const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
    if (!m || matchesAny(CARRY_TEST_GLOBS, m[3]!) || matchesAny(CARRY_METADATA_GLOBS, m[3]!)) continue;
    n += Number(m[1]) + Number(m[2]);
  }
  return n;
}

/** Product drift since `from` along the branch's first-parent line: main merges and the commits they bring are not counted. */
export function driftLines(cwd: string, from: string, head: string): number | null {
  const r = spawnSync('git', ['log', '--no-merges', '--first-parent', '--numstat', '--format=', `${from}..${head}`], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? driftFromNumstat(r.stdout) : null;
}

export interface RouteGrant { kind: 'design-change' | 'extra-round'; approval: string }
export type Route = { route: 'first' | 'recheck' | 'review'; reason: string };

/**
 * What the next head of the PR gets. Before any round: the first review, as today. After one: the scoped re-check
 * (when carry says it is eligible), except that a review round is due when the PR drifted past PR_DRIFT_LINES since
 * its first full round, when two re-checks found a blocker since the last full round, or when the lane or its
 * Captain recorded a design change at this head. The plan then caps the round (gstack-review-plan --prior-rounds).
 */
export function reviewRoute(h: Pick<PrReviewHistory, 'rounds' | 'recheck_blocked'>, o: { drift: number | null; grant?: RouteGrant }): Route {
  if (!h.rounds) return { route: 'first', reason: 'no review round on this PR yet' };
  if (o.grant?.kind === 'design-change') return { route: 'review', reason: `a design-change round grant ${o.grant.approval} names this head` };
  if (h.recheck_blocked >= 2) return { route: 'review', reason: `${h.recheck_blocked} scoped re-checks found a blocker since the last full round` };
  if (o.drift !== null && o.drift > PR_DRIFT_LINES) return { route: 'review', reason: `product drift since the first full round is ${o.drift} lines, over ${PR_DRIFT_LINES}` };
  return { route: 'recheck', reason: `the PR had ${h.rounds} review round${h.rounds === 1 ? '' : 's'}; a new head takes the scoped re-check of what changed since the last reviewed head (R51)` };
}

const s12 = (s: string | null) => (s ? s.slice(0, 12) : 'none');

export function historyLine(pr: string, h: PrReviewHistory, drift: number | null): string {
  return `PR_REVIEW_HISTORY: pr=#${pr} rounds=${h.rounds} cap=${FULL_PASS_CAP} full=${h.full} scoped=${h.scoped} fix_checks=${h.fix_checks} rechecks=${h.rechecks} recheck_blocked=${h.recheck_blocked} runs=${h.runs} stubs=${h.stubs} heads_reviewed=${h.heads} first_full=${s12(h.first_full)} last_full=${s12(h.last_full)} drift_lines=${drift ?? 'unknown'} source=${h.source}`;
}
