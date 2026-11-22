/**
 * HARN-109 (harness-evals#507): a /ship run dispatched its granted readers, then ran a reader by hand and never ran Step
 * 9.4's persistence, so the review log held no row from the run, gstack-review-read printed NO_REVIEWS and the fix-check
 * grant could not bind. gstack-review-scope summary reads both the run's dispatch ledgers and its rows, so it warns when
 * readers produced output that no row of this run records. A run that logged its rows gets no warning.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { collect, readJsonl, recordJudgment, type MergedLine } from '../lib/review-ledger';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(60_000);
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const SINCE = '2026-11-02T01:00:00Z';
const at = (min: number) => new Date(Date.parse(SINCE) + min * 60_000).toISOString();
const review = (min: number) => ({ skill: 'review', via: 'ship', timestamp: at(min), status: 'clean', review_scope: 'frozen', pass: 1, findings: [] });
const fixCheck = (min: number) => ({ skill: 'review-fix-check', via: 'ship', timestamp: at(min), review_scope: 'frozen', completed: true, converged: true, findings: [] });

/** One pass directory of the run: each reader's output collected into its ledger and judged as labelled. */
function ledger(dir: string, reader: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'review-ledger.jsonl');
  const mergedFile = path.join(dir, 'merged.jsonl');
  fs.writeFileSync(mergedFile, '');
  expect(collect(file, reader, 'NO FINDINGS', mergedFile).review).toBe(true);
  const merged = readJsonl<MergedLine>(mergedFile);
  const judgedFile = path.join(dir, 'judged.jsonl');
  fs.writeFileSync(judgedFile, merged.map(m => JSON.stringify({ id: m.id, severity: m.label }) + '\n').join(''));
  expect(recordJudgment(file, merged, merged.map(m => ({ id: m.id, severity: m.label })), judgedFile, mergedFile).ok).toBe(true);
}

function branchWith(rows: object[] | null): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'harn109-' });
  repos.push(repo);
  repo.git('checkout', '-qb', 'feat');
  if (rows) {
    const logDir = path.join(repo.home, 'projects', runBin(repo, 'gstack-slug', ['--get', 'SLUG']).out.trim());
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'feat-reviews.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  }
  return repo;
}
const summary = (repo: FixtureRepo, run: string) => runBin(repo, 'gstack-review-scope', ['summary', '--since', SINCE, '--run', run, '--json']);

describe('summary warns when a run\'s readers ran but it logged no rows (HARN-109)', () => {
  // Value: protects=a run that dispatched readers and skipped Step 9.4 hears so before finish refuses on NO_REVIEWS;
  //   fails_when=summary counts the fix-check ledger and stays silent; seam=bin/gstack-review-scope summary; no_claim=-
  test('a granted fix-check reader with no review-log row at all warns', () => {
    const repo = branchWith(null);
    const run = path.join(repo.root, 'run');
    ledger(path.join(run, 'fc'), 'fix-check');
    const r = summary(repo, run);
    expect(r.err).toContain('REVIEW_ROWS_MISSING:');
    expect(r.err).toContain('fc');
    expect(r.err).toContain('gstack-review-log');
  });

  // Value: protects=a fix-check whose row was never logged is named even when the pass rows exist; fails_when=only the
  //   zero-row case warns; seam=summary; no_claim=-
  test('a fix-check ledger with no review-fix-check row warns beside a logged pass', () => {
    const repo = branchWith([review(5)]);
    const run = path.join(repo.root, 'run');
    ledger(path.join(run, 'p1'), 'security');
    ledger(path.join(run, 'fc'), 'fix-check');
    const r = summary(repo, run);
    expect(r.status).toBe(EXIT.ok);
    expect(r.err).toContain('REVIEW_ROWS_MISSING:');
    expect(r.err).toContain('fc');
  });

  // Value: protects=a pass whose review row was never logged is named even when a Step 11 voice row was; fails_when=any
  //   via:ship row counts as the pass's row; seam=summary; no_claim=-
  test('a pass ledger with no review row warns beside a logged voice row', () => {
    const repo = branchWith([{ skill: 'adversarial-review', via: 'ship', timestamp: at(20), status: 'clean', findings: [] }]);
    const run = path.join(repo.root, 'run');
    ledger(path.join(run, 'p1'), 'security');
    const r = summary(repo, run);
    expect(r.err).toContain('REVIEW_ROWS_MISSING: readers ran (ledger p1)');
  });

  // Value: protects=no warning when every reader's row is logged (negative control); fails_when=the warning fires on a
  //   normal run; seam=summary; no_claim=-
  test('a run that logged its pass and fix-check rows gets no warning', () => {
    const repo = branchWith([review(5), fixCheck(30)]);
    const run = path.join(repo.root, 'run');
    ledger(path.join(run, 'p1'), 'security');
    ledger(path.join(run, 'fc'), 'fix-check');
    const r = summary(repo, run);
    expect(r.status).toBe(EXIT.ok);
    expect(r.err).not.toContain('REVIEW_ROWS_MISSING');
  });
});
