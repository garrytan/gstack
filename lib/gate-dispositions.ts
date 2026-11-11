/**
 * Owner gate dispositions (GST-2491, docs/ship-policy.md#gate-dispositions): the owner's recorded answer to a gate finding
 * (a loosened gate the review logged with a `gate` tag). An unattended session cannot answer `review-gate-disposition`, so
 * gstack-review-log logs its gate findings `open`; the owner closes one through the approval record instead, with
 * `gstack-approvals gate`, outside the lane's /ship run. A disposition is one approved row with scope
 * `gate_disposition <fingerprint> <head>` and ask `gate_disposition <fingerprint> at <head>: <reason>`, the owner's exact
 * words in `words`, the recorder in `by` and the time in `recorded_at`. A review-log field never makes one.
 */
import { spawnSync } from 'node:child_process';
import { locate, readRecord, type ApprovalRow, type Env } from './approval-record';
import { GSTACK_ACTOR } from './ruled-notes';

export interface GateDisposition { finding: string; head: string; by: string; reason: string; words: string; at: string; approval: string }

const SCOPE = /^gate_disposition (\S+) ([0-9a-f]{40})$/;
const ASK = /^gate_disposition (\S+) at ([0-9a-f]{40}): (\S(?:.*\S)?)$/;
export const GATE_DISPOSITION_SCOPE = /^\s*gate_disposition\b/;
export const ONE_LINE = /^[^\x00-\x1f\x7f]*$/;

export const gateDispositionRow = (finding: string, head: string, reason: string) => ({ scope: `gate_disposition ${finding} ${head}`, ask: `gate_disposition ${finding} at ${head}: ${reason}` });

/** The approved disposition rows, one per finding and head (the newest wins); a row gstack wrote, or one without the owner's one-line words, is none. */
export function gateDispositions(rows: readonly ApprovalRow[]): GateDisposition[] {
  const byFinding = new Map<string, GateDisposition>();
  for (const r of rows) {
    const scope = SCOPE.exec(r.scope), ask = ASK.exec(r.ask);
    if (r.outcome !== 'approved' || !scope || !ask || ask[1] !== scope[1] || ask[2] !== scope[2] || GSTACK_ACTOR.test(r.by) || !r.words?.trim() || !ONE_LINE.test(r.words)) continue;
    const finding = scope[1]!, head = scope[2]!, key = `${finding} ${head}`;
    byFinding.delete(key);
    byFinding.set(key, { finding, head, by: r.by, reason: ask[3]!, words: r.words, at: r.recorded_at, approval: r.id });
  }
  return [...byFinding.values()];
}

/** The dispositions in the checked-out branch's approval record (and its mirror). */
export function readGateDispositions(cwd: string, env: Env = process.env): GateDisposition[] {
  const loc = locate({ cwd, env });
  return 'code' in loc ? [] : gateDispositions(readRecord(loc).rows);
}

/** The one-line form finish prints after `GATE_DISPOSITION: ` and the PR body carries after `Gate disposition: `. */
export const gateDispositionText = (d: GateDisposition) => `${d.finding} at ${d.head.slice(0, 12)} by ${d.by} at ${d.at}: ${d.reason} — "${d.words}" (approval ${d.approval})`;

/**
 * The fingerprints of a review row's `open` gate findings that a disposition closes: the same fingerprint, recorded at a head
 * inside the row's `range_base..commit_full` (both ends included, the test rulings and review_loop_grant use), or at the row's
 * own commit when the row has no range_base (a first pass). Nothing on the row itself counts.
 */
export function dispositionedOn(cwd: string, row: Record<string, any>, dispositions: readonly GateDisposition[]): Set<string> {
  const open = new Set((Array.isArray(row?.findings) ? row.findings : []).filter((f: any) => !!f && typeof f.gate === 'string' && f.gate && f.action === 'open' && typeof f.fingerprint === 'string').map((f: any) => f.fingerprint as string));
  const mine = dispositions.filter(d => open.has(d.finding));
  if (!mine.length) return new Set();
  const commitOf = (c: unknown) => typeof c === 'string' && /^[0-9a-f]{7,40}$/.test(c) ? spawnSync('git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], { cwd, encoding: 'utf8', timeout: 10_000 }).stdout?.trim() ?? '' : '';
  const ancestor = (a: string, d: string) => spawnSync('git', ['merge-base', '--is-ancestor', a, d], { cwd, timeout: 10_000 }).status === 0;
  const to = commitOf(row.commit_full), from = row.range_base == null ? '' : commitOf(row.range_base);
  if (!to || (row.range_base != null && !from)) return new Set();
  return new Set(mine.filter(d => from ? ancestor(from, d.head) && ancestor(d.head, to) : d.head === to).map(d => d.finding));
}
