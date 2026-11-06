/**
 * Owner-ruled notes (GST-1537, docs/ship-policy.md#ruled-notes): the owner's ruling that a review finding ships as a
 * disclosed note instead of a fix. A ruling is one approved gstack-approvals row (`gstack-approvals rule`), with scope
 * `ruled_note <finding fingerprint> <head>` and ask `ruled_note <finding fingerprint> at <head>: <reason>`, where head is the
 * full sha of the stop head the owner ruled at; the row's `by` is the ruler and its `recorded_at` the time. A review-log field
 * never makes one, so the lane that logged a finding cannot close it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { locate, readRecord, type ApprovalRow, type Env } from './approval-record';

export interface RuledNote { finding: string; head: string; by: string; reason: string; at: string; approval: string }

const SCOPE = /^ruled_note (\S+) ([0-9a-f]{40})$/;
const ASK = /^ruled_note (\S+) at ([0-9a-f]{40}): (\S(?:.*\S)?)$/;
/** A ruler gstack names for itself (the no-stop default's `gstack no-stop default (K1)`) is no owner. */
export const GSTACK_ACTOR = /^gstack\b/i;
export const RULED_NOTE_SCOPE = /^\s*ruled_note\b/;

export const ruledNoteRow = (finding: string, head: string, reason: string) => ({ scope: `ruled_note ${finding} ${head}`, ask: `ruled_note ${finding} at ${head}: ${reason}` });

/** The approved ruling rows, one per finding and head (the newest wins). */
export function ruledNotes(rows: readonly ApprovalRow[]): RuledNote[] {
  const byFinding = new Map<string, RuledNote>();
  for (const r of rows) {
    const scope = SCOPE.exec(r.scope), ask = ASK.exec(r.ask);
    if (r.outcome !== 'approved' || !scope || !ask || ask[1] !== scope[1] || ask[2] !== scope[2] || GSTACK_ACTOR.test(r.by)) continue;
    const finding = scope[1]!, head = scope[2]!, key = `${finding} ${head}`;
    byFinding.delete(key);
    byFinding.set(key, { finding, head, by: r.by, reason: ask[3]!, at: r.recorded_at, approval: r.id });
  }
  return [...byFinding.values()];
}

/** The rulings in the checked-out branch's approval record (and its mirror). */
export function readRuledNotes(cwd: string, env: Env = process.env): RuledNote[] {
  const loc = locate({ cwd, env });
  return 'code' in loc ? [] : ruledNotes(readRecord(loc).rows);
}

/** The one-line form finish prints after `RULED_NOTE: ` and the PR body carries after `Ruled note: `. */
export const ruledNoteText = (n: RuledNote) => `${n.finding} at ${n.head.slice(0, 12)} ruled by ${n.by} at ${n.at}: ${n.reason} (approval ${n.approval})`;

/** The /ship run open on this checkout (its marker in the git dir, which finish removes), if any. */
export function openShipRun(cwd: string): string | undefined {
  const p = spawnSync('git', ['rev-parse', '--git-path', 'gstack-ship-run'], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (p.status !== 0 || !p.stdout.trim()) return undefined;
  try { return fs.readFileSync(path.resolve(cwd, p.stdout.trim()), 'utf8').trim() || undefined; } catch { return undefined; }
}
