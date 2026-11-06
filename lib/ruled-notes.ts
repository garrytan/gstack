/**
 * Owner-ruled notes (GST-1537, docs/ship-policy.md#ruled-notes): the owner's ruling that a review finding ships as a
 * disclosed note instead of a fix. A ruling is one approved gstack-approvals row (`gstack-approvals rule`), with scope
 * `ruled_note <finding fingerprint>` and ask `ruled_note: <reason>`; the row's `by` is the ruler and its
 * `recorded_at` the time. A review-log field never makes one, so the lane that logged a finding cannot close it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { locate, readRecord, type ApprovalRow, type Env } from './approval-record';

export interface RuledNote { finding: string; by: string; reason: string; at: string; approval: string }

const SCOPE = /^ruled_note (\S(?:.*\S)?)$/;
const ASK = /^ruled_note: (\S(?:.*\S)?)$/;
/** A ruler gstack names for itself (the no-stop default's `gstack no-stop default (K1)`) is no owner. */
export const GSTACK_ACTOR = /^gstack\b/i;
export const RULED_NOTE_SCOPE = /^\s*ruled_note\b/;

export const ruledNoteRow = (finding: string, reason: string) => ({ scope: `ruled_note ${finding}`, ask: `ruled_note: ${reason}` });

/** The approved ruling rows, one per finding (the newest wins). */
export function ruledNotes(rows: readonly ApprovalRow[]): RuledNote[] {
  const byFinding = new Map<string, RuledNote>();
  for (const r of rows) {
    const finding = SCOPE.exec(r.scope)?.[1], reason = ASK.exec(r.ask)?.[1];
    if (r.outcome !== 'approved' || !finding || !reason || GSTACK_ACTOR.test(r.by)) continue;
    byFinding.delete(finding);
    byFinding.set(finding, { finding, by: r.by, reason, at: r.recorded_at, approval: r.id });
  }
  return [...byFinding.values()];
}

/** The rulings in the checked-out branch's approval record (and its mirror). */
export function readRuledNotes(cwd: string, env: Env = process.env): RuledNote[] {
  const loc = locate({ cwd, env });
  return 'code' in loc ? [] : ruledNotes(readRecord(loc).rows);
}

/** The one-line form finish prints after `RULED_NOTE: ` and the PR body carries after `Ruled note: `. */
export const ruledNoteText = (n: RuledNote) => `${n.finding} ruled by ${n.by} at ${n.at}: ${n.reason} (approval ${n.approval})`;

/** The /ship run open on this checkout (its marker in the git dir, which finish removes), if any. */
export function openShipRun(cwd: string): string | undefined {
  const p = spawnSync('git', ['rev-parse', '--git-path', 'gstack-ship-run'], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (p.status !== 0 || !p.stdout.trim()) return undefined;
  try { return fs.readFileSync(path.resolve(cwd, p.stdout.trim()), 'utf8').trim() || undefined; } catch { return undefined; }
}
