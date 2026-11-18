/**
 * GST-3054: a carried CI run whose tree.json says some files passed only on a re-run attempt (gbrain#9690's
 * `rerun_files` and `attempts`) still carries, but every carry receipt and the SHIP_RECEIPT line say so
 * (`rerun=<n> attempts=<list>`), and a malformed record fails closed. The dependencies are fakes; nothing reaches GitHub.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findCarry } from '../lib/ci-carry';
import { RESULT_CODES } from '../lib/result-codes';
import { receiptSummaryLine, validateReceipt } from '../lib/ship-receipt';
import { rerunByRun, runReceiptFields, type ApiRun, type RunDeps, type RunProfile, type RunSource, type TreeRecord } from '../lib/run-evidence';

const REPO = 'garrytan/gstack';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const NOW = new Date('2026-11-02T12:00:00Z');
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['workflow_dispatch'], jobs: ['free-tests'], artifact: 'tested-tree', os: 'Linux' };
const FIXTURES = path.join(import.meta.dir, 'fixtures', 'ci-carry-rerun');
const fixture = (name: string): TreeRecord => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const INVENTORY = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];

function source(rec: TreeRecord): RunSource {
  const r: ApiRun = { id: rec.run_id as number, run_attempt: rec.run_attempt as number, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: HEAD,
    path: '.github/workflows/free-tests.yml', created_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T11:30:00Z', repository: { full_name: REPO }, head_repository: { full_name: REPO } };
  const deps: RunDeps = {
    run: () => r,
    runsForHead: (_wf, sha) => (sha === HEAD ? [r] : []),
    jobs: () => [{ name: 'free-tests', conclusion: 'success', completed_at: '2026-11-02T11:30:00Z' }],
    artifact: () => rec,
    commitTree: sha => (sha === HEAD ? TREE : null),
  };
  return { repo: REPO, deps, profiles: { 'ci-reuse/free-tests': PROFILE }, now: NOW };
}
const carry = (rec: TreeRecord, inventory = true) => findCarry(source(rec), { profiles: ['ci-reuse/free-tests'], head: HEAD, tree: TREE, wtree: () => TREE, ...(inventory ? { inventory: () => INVENTORY } : {}) });
const receipt = (ci_carried: unknown) => ({ schema_version: 1 as const, head: HEAD, base: 'main', ci_carried } as Parameters<typeof receiptSummaryLine>[0]);

describe('a carried run that passed only after a re-run (GST-3054)', () => {
  // Value: protects=a tree.json without rerun_files carries exactly as before; fails_when=the marker appears on a clean first-attempt run
  test('a tree.json without rerun_files or attempts carries with no rerun marker', () => {
    for (const inventory of [true, false]) {
      const v = carry(fixture('no-fields.tree.json'), inventory);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.receipt).not.toMatch(/ rerun=| attempts=/);
      expect(v.runs[0]!.rerun).toBeUndefined();
      expect(v.runs[0]!.attempts).toBeUndefined();
    }
    const empty = carry({ ...fixture('no-fields.tree.json'), rerun_files: [], attempts: [1] });
    expect(empty.ok).toBe(true);
    expect(empty.ok ? empty.receipt : '').not.toContain('rerun=');
    const line = receiptSummaryLine(receipt([{ lane: 'free', run: 4, attempt: 1, tree: TREE }]));
    expect(line).toContain('ci_carried=free:4/1');
    expect(line).not.toMatch(/ rerun=| attempts=/);
  });

  // Value: protects=a re-run pass is marked, never presented as clean; fails_when=rerun_files is ignored again or the carry refuses it
  test('rerun_files carries, and the carry receipt names the re-run count and the attempts', () => {
    for (const inventory of [true, false]) {
      const v = carry(fixture('rerun.tree.json'), inventory);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.receipt).toContain(' runs=5/2 ');
      expect(v.receipt).toContain(' rerun=2 attempts=1,2 ');
      expect([v.runs[0]!.rerun, v.runs[0]!.attempts]).toEqual([['test/b.test.ts', 'test/c.test.ts'], [1, 2]]);
    }
  });

  // Value: protects=the SHIP_RECEIPT line ready and land print shows the marker; fails_when=the receipt drops it or it fails schema validation
  test('the receipt records rerun and attempts per carried run, and SHIP_RECEIPT shows them after ci_carried', () => {
    const r = receipt([{ lane: 'free', run: 5, attempt: 2, tree: TREE, rerun: 2, attempts: [1, 2] }, { lane: 'lint', run: 5, attempt: 2, tree: TREE, rerun: 2, attempts: [1, 2] }]);
    expect(validateReceipt(r)).toEqual([]);
    expect(receiptSummaryLine(r)).toContain('ci_carried=free:5/2,lint:5/2 rerun=2 attempts=1,2');
    expect(validateReceipt(receipt([{ lane: 'free', run: 5, attempt: 2, tree: TREE, rerun: '2', attempts: 'x' }])).length).toBeGreaterThan(0);
  });

  // Value: protects=an unmarked lane on the same run never hides the marker, and two profiles on one run count each file once; fails_when=the last entry or profile overwrites or double-counts
  test('lanes and profiles that share a run keep the marker and count each re-run file once', () => {
    expect(receiptSummaryLine(receipt([{ lane: 'free', run: 5, attempt: 2, tree: TREE, rerun: 1, attempts: [1, 2] }, { lane: 'lint', run: 5, attempt: 2, tree: TREE }]))).toContain('ci_carried=free:5/2,lint:5/2 rerun=1 attempts=1,2');
    const run = { run_id: 5, run_attempt: 2, head_sha: HEAD, tree: TREE, event: 'workflow_dispatch', finished_at: '2026-11-02T11:30:00Z', files: INVENTORY, tests: 3, rerun: ['test/b.test.ts'], attempts: [2, 1, 2] };
    expect(runReceiptFields([{ ...run, profile: 'one' }, { ...run, profile: 'two' }], NOW)).toContain(' rerun=1 attempts=1,2 ');
    expect([...rerunByRun([run, { ...run, rerun: ['test/c.test.ts'] }])]).toEqual([['5/2', { files: 2, attempts: [1, 2] }]]);
  });

  // Value: protects=fail closed on a malformed re-run record; fails_when=a non-array or non-string rerun_files, or bad attempts, carries
  test('a malformed rerun_files or attempts refuses with CI_CARRY_RERUN_MALFORMED', () => {
    const bad: Array<Partial<TreeRecord>> = [{}, { rerun_files: [1] }, { rerun_files: ['test/b.test.ts'], attempts: '1,2' }, { rerun_files: ['test/b.test.ts'], attempts: [0, 2] }, { rerun_files: ['test/b.test.ts'], attempts: ['2'] }];
    for (const over of bad) {
      const v = carry({ ...fixture('malformed.tree.json'), ...over });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.reason).toBe('no_verified_run');
      expect(v.detail).toContain('rerun_malformed');
      expect(v.detail).toContain('(CI_CARRY_RERUN_MALFORMED)');
    }
    expect(RESULT_CODES.CI_CARRY_RERUN_MALFORMED.anchor).toBe('ci-carry-rerun-malformed');
  });
});
