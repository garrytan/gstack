/**
 * Owner-granted test-lane exceptions (GST-1595, docs/ship-policy.md#test-lane-exceptions): the owner's grant that a lane
 * carries from CI although some of its inventory files are in no run's tree.json (bun registers an imported test file's
 * tests under the importer, so the imported file's JUnit suite never appears). A grant is one approved gstack-approvals
 * row (`gstack-approvals lane-exception`), scope `test_lane_exception <head> <files>` and ask
 * `test_lane_exception at <head>: <files>: <reason>`, where head is the full sha of the pushed head the owner granted at and
 * files are exactly the uncovered files, comma-separated. It binds only at that head and only for that exact set, and
 * `gstack-evidence record-ci` counts it only after a local preflight of exactly those files passes there. Like a ruled note
 * (lib/ruled-notes.ts), a row by gstack itself is no grant, and the CLI refuses inside the checkout's open /ship run, so the
 * lane that needs the exception cannot write it for itself.
 */
import { locate, readRecord, type ApprovalRow, type Env } from './approval-record';
import { GSTACK_ACTOR } from './ruled-notes';

export interface TestLaneException { head: string; files: string[]; by: string; reason: string; at: string; approval: string }
/** What the ledger's CI row and the receipt's ci_carried entry keep: the grant plus the preflight that backed it. */
export interface BoundLaneException extends TestLaneException { preflight: { label: string; tests_ran: number } }

const SCOPE = /^test_lane_exception ([0-9a-f]{40}) (\S+)$/;
const ASK = /^test_lane_exception at ([0-9a-f]{40}): (\S+): (\S(?:.*\S)?)$/;
export const TEST_LANE_EXCEPTION_SCOPE = /^\s*test_lane_exception\b/;

export const testLaneExceptionRow = (head: string, files: string[], reason: string) =>
  ({ scope: `test_lane_exception ${head} ${files.join(',')}`, ask: `test_lane_exception at ${head}: ${files.join(',')}: ${reason}` });

/** The approved grants, one per head and file set (the newest wins), so each lane at a head keeps its own grant. */
export function testLaneExceptions(rows: readonly ApprovalRow[]): TestLaneException[] {
  const byGrant = new Map<string, TestLaneException>();
  for (const r of rows) {
    const scope = SCOPE.exec(r.scope), ask = ASK.exec(r.ask);
    if (r.outcome !== 'approved' || !scope || !ask || ask[1] !== scope[1] || ask[2] !== scope[2] || GSTACK_ACTOR.test(r.by)) continue;
    const files = scope[2]!.split(',').filter(Boolean).sort(), key = `${scope[1]} ${files.join(',')}`;
    byGrant.delete(key);
    byGrant.set(key, { head: scope[1]!, files, by: r.by, reason: ask[3]!, at: r.recorded_at, approval: r.id });
  }
  return [...byGrant.values()];
}

/** The grants in the checked-out branch's approval record (and its mirror). */
export function readTestLaneExceptions(cwd: string, env: Env = process.env): TestLaneException[] {
  const loc = locate({ cwd, env });
  return 'code' in loc ? [] : testLaneExceptions(readRecord(loc).rows);
}

/** The `Test-lane exception: …` lines a receipt's ci_carried entries require in the PR body, one per grant. */
export function laneExceptionBodyLines(carried: unknown): string[] {
  const list = Array.isArray(carried) ? carried : [];
  return [...new Set(list.flatMap(c => {
    const e = (c as { exception?: BoundLaneException } | null)?.exception;
    return e && Array.isArray(e.files) && typeof e.head === 'string' && e.preflight ? [`Test-lane exception: ${testLaneExceptionText(e)}`] : [];
  }))];
}

/** The text after `TEST_LANE_EXCEPTION: ` in accept's output and after `Test-lane exception: ` in the PR body. */
export const testLaneExceptionText = (e: BoundLaneException) =>
  `${e.files.join(', ')} at ${e.head.slice(0, 12)}: preflight ${e.preflight.label} ran ${e.preflight.tests_ran} test(s) here; granted by ${e.by} at ${e.at}: ${e.reason} (approval ${e.approval})`;
