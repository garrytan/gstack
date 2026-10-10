/**
 * B7: review-log status derived from findings. Pins the write-time rule
 * (`status: clean` beside open findings is rejected with
 * REVIEW_STATUS_MISMATCH, exit 1, nothing written), the derived counters
 * (findings_total/open/resolved, status_source), the exit matrix (usage 2),
 * validation before the start token is consumed (a rejected write retries),
 * and reviewFreshness reading findings_open so resolved critical findings no
 * longer downgrade a clean row.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReviewLogError, bindReview, deriveFromFindings, reviewFreshness } from '../lib/review-evidence';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-review-log');

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-revlog-findings-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BIN, args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_HOME: home, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function writtenRows(): any[] {
  const projects = path.join(home, 'projects');
  if (!fs.existsSync(projects)) return [];
  return fs.readdirSync(projects).flatMap(slug => fs.readdirSync(path.join(projects, slug))
    .filter(f => f.endsWith('-reviews.jsonl'))
    .flatMap(f => fs.readFileSync(path.join(projects, slug, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))));
}
function findings(rows: Record<string, unknown>[], name = 'findings.jsonl'): string {
  const file = path.join(home, name);
  fs.writeFileSync(file, rows.map(r => JSON.stringify({ schema_version: 1, run: 'r', phase: 'eng', voice: 'native', title: 't', ...r })).join('\n') + '\n');
  return file;
}
const open176 = Array.from({ length: 176 }, (_, i) => ({ id: `r-eng-native-${i + 1}`, severity: i < 3 ? 'Critical' : 'High', disposition: 'open' }));

describe('write-time derivation (the hand-written clean-beside-176 incident)', () => {
  test('claimed clean beside open findings is rejected: exit 1, REVIEW_STATUS_MISMATCH on stderr, nothing written', () => {
    const file = findings(open176);
    const r = run([JSON.stringify({ skill: 'plan-eng-review', status: 'clean', issues_found: 176 }), '--findings', file]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^review-log: status mismatch: claimed status "clean", findings file has "issues_open" \(176 open of 176\) \(REVIEW_STATUS_MISMATCH\)$/m);
    expect(r.err).not.toContain('invalid JSON');
    expect(writtenRows()).toEqual([]);
  });

  test('a row without claims is derived from the file and tagged status_source derived', () => {
    const file = findings(open176);
    const r = run([JSON.stringify({ skill: 'plan-eng-review', mode: 'FULL_REVIEW' }), '--findings', file]);
    expect(r.code).toBe(0);
    const [row] = writtenRows();
    expect(row).toMatchObject({ skill: 'plan-eng-review', status: 'issues_open', unresolved: 176, issues_found: 176, critical_gaps: 3,
      findings_total: 176, findings_open: 176, findings_resolved: 0, status_source: 'derived', findings_file: file });
  });

  test('claimed values that agree with the file pass; mismatched counters are named', () => {
    const file = findings([
      { id: 'r-eng-native-1', severity: 'Critical', disposition: 'accepted' },
      { id: 'r-eng-native-2', severity: 'High', disposition: 'open' },
    ]);
    expect(run([JSON.stringify({ skill: 'plan-eng-review', status: 'issues_open', unresolved: 1, critical_gaps: 0 }), '--findings', file]).code).toBe(0);
    const bad = run([JSON.stringify({ skill: 'plan-eng-review', status: 'issues_open', unresolved: 0, critical_gaps: 1 }), '--findings', file]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('claimed unresolved 0, findings file has 1');
    expect(bad.err).toContain('claimed critical_gaps 1, findings file has 0');
    expect(writtenRows()).toHaveLength(1);
  });

  test('resolved critical findings derive a clean row with findings_total > 0 (migration case)', () => {
    const file = findings([
      { id: 'r-1', severity: 'Critical', disposition: 'fixed' },
      { id: 'r-2', severity: 'Critical', disposition: 'accepted' },
      { id: 'r-3', severity: 'Low', disposition: 'deferred' },
    ]);
    const r = run([JSON.stringify({ skill: 'plan-ceo-review', via: 'autoplan' }), '--findings', file]);
    expect(r.code).toBe(0);
    expect(writtenRows()[0]).toMatchObject({ status: 'clean', unresolved: 0, issues_found: 3, critical_gaps: 0, findings_total: 3, findings_open: 0, findings_resolved: 3 });
  });

  test('rows written without --findings are tagged status_source claimed and keep their values', () => {
    const r = run([JSON.stringify({ skill: 'plan-eng-review', status: 'clean', issues_found: 2 })]);
    expect(r.code).toBe(0);
    expect(writtenRows()[0]).toMatchObject({ status: 'clean', issues_found: 2, status_source: 'claimed' });
    expect(writtenRows()[0].findings_open).toBeUndefined();
  });

  test('caller-supplied derived tags are discarded, never trusted', () => {
    const r = run([JSON.stringify({ skill: 'plan-eng-review', status: 'clean', status_source: 'derived', findings_open: 0, findings_total: 9 })]);
    expect(r.code).toBe(0);
    expect(writtenRows()[0]).toMatchObject({ status_source: 'claimed' });
    expect(writtenRows()[0].findings_total).toBeUndefined();
  });

  test('a malformed findings tail or a missing file rejects the row with its artifact code', () => {
    const file = findings(open176.slice(0, 2));
    fs.appendFileSync(file, '{"schema_version": 1, "id": "r-eng-nat');
    const tail = run([JSON.stringify({ skill: 'plan-eng-review' }), '--findings', file]);
    expect(tail.code).toBe(1);
    expect(tail.err).toContain('(ARTIFACT_MALFORMED_JSONL)');
    const missing = run([JSON.stringify({ skill: 'plan-eng-review' }), '--findings', path.join(home, 'nope.jsonl')]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('(ARTIFACT_MISSING)');
    expect(writtenRows()).toEqual([]);
  });
});

describe('exit matrix and token handling', () => {
  test('usage is 2: no args, unknown flag, flag without value, bare flag as the record', () => {
    for (const args of [[], ['{}', '--bogus'], ['{}', '--findings'], ['--finish', 'x']]) {
      const r = run(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain('Exit codes: 0 written · 1 rejected · 2 usage');
    }
  });

  test('invalid JSON is 1 with its own message (not folded into a binding failure)', () => {
    const r = run(['not json']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^gstack-review-log: invalid JSON, skipping/m);
  });

  test('a rejected --findings write leaves the start token for the retry; the corrected row consumes it', () => {
    const token = run(['--start', 'review']).out.trim();
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const file = findings([{ id: 'r-review-native-1', severity: 'High', disposition: 'open' }]);
    const rejected = run([JSON.stringify({ skill: 'review', status: 'clean', completed: true, converged: true }), '--finish', token, '--findings', file]);
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain('(REVIEW_STATUS_MISMATCH)');
    const starts = fs.readdirSync(path.join(home, 'projects')).flatMap(slug => {
      const dir = path.join(home, 'projects', slug, '.review-starts');
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    });
    expect(starts).toEqual([`${token}.json`]);
    const retry = run([JSON.stringify({ skill: 'review', completed: true, converged: true }), '--finish', token, '--findings', file]);
    expect(retry.code).toBe(0);
    const [row] = writtenRows();
    expect(row).toMatchObject({ status: 'issues_open', findings_open: 1, status_source: 'derived' });
    expect(row.review_binding.state).toBe('verified');
    expect(run([JSON.stringify({ skill: 'review', completed: true, converged: true }), '--finish', token]).code).toBe(0);
    expect(writtenRows()[1].review_binding.state).toBe('uncaptured');
  });

  test('unattended session: the row is written but the sync enqueue is skipped with an explicit line', () => {
    const r = run([JSON.stringify({ skill: 'plan-eng-review', status: 'clean' })], { GSTACK_SESSION_KIND: 'unattended' });
    expect(r.code).toBe(0);
    expect(r.err.trim()).toBe('review-log: sync skipped (unattended session)');
    expect(writtenRows()).toHaveLength(1);
  });
});

describe('lib: deriveFromFindings, bindReview order and reviewFreshness', () => {
  test('deriveFromFindings throws a typed ReviewLogError on mismatch and succeeds without claims', () => {
    const file = findings(open176.slice(0, 5));
    let caught: unknown;
    try { deriveFromFindings({ skill: 'x', status: 'clean' }, file); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ReviewLogError);
    expect((caught as ReviewLogError).code).toBe('REVIEW_STATUS_MISMATCH');
    expect(deriveFromFindings({ skill: 'x' }, file)).toMatchObject({ status: 'issues_open', findings_open: 5, critical_gaps: 3 });
  });

  test('bindReview validates the findings file before touching the token file', () => {
    const dir = path.join(home, 'starts', '.review-starts');
    fs.mkdirSync(dir, { recursive: true });
    const token = '11111111-2222-3333-4444-555555555555';
    fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify({ skill: 'review', repo: '/r', branch: 'b', wtree: 'a'.repeat(64), started_at: 't' }));
    const env = { GSTACK_REVIEW_DIR: path.join(home, 'starts'), GSTACK_REVIEW_REPO: '/r', GSTACK_REVIEW_BRANCH: 'b', GSTACK_STAMP_WTREE: 'a'.repeat(64) };
    const file = findings([{ id: 'r-1', severity: 'High', disposition: 'open' }]);
    expect(() => bindReview({ skill: 'review', status: 'clean', completed: true, converged: true }, token, env, file)).toThrow(ReviewLogError);
    expect(fs.existsSync(path.join(dir, `${token}.json`))).toBe(true);
    const bound = bindReview({ skill: 'review', completed: true, converged: true }, token, env, file);
    expect(bound.review_binding.state).toBe('verified');
    expect(bound.findings_open).toBe(1);
    expect(fs.existsSync(path.join(dir, `${token}.json`))).toBe(false);
  });

  test('reviewFreshness reads findings_open: resolved criticals are CURRENT, claimed issues_found stays conservative', () => {
    const w = 'b'.repeat(64);
    const base = { skill: 'review', completed: true, converged: true, wtree: w, review_binding: { state: 'verified', start_wtree: w, end_wtree: w } };
    expect(reviewFreshness({ ...base, status: 'clean', issues_found: 3, findings_total: 3, findings_open: 0, findings_resolved: 3, status_source: 'derived' }, w))
      .toEqual({ status: 'CURRENT', reason: 'completed clean pass on unchanged content' });
    expect(reviewFreshness({ ...base, status: 'clean', issues_found: 3, status_source: 'claimed' }, w)?.status).toBe('UNVERIFIED');
    expect(reviewFreshness({ ...base, status: 'clean', findings_open: 1, issues_found: 1 }, w)?.status).toBe('UNVERIFIED');
    expect(reviewFreshness({ ...base, status: 'clean', findings_open: 0, critical: 1 }, w)?.status).toBe('UNVERIFIED');
    expect(reviewFreshness({ ...base, skill: 'codex-review', status: 'clean', findings_open: 0, findings: 2, findings_fixed: 1 }, w)?.status).toBe('UNVERIFIED');
  });
});
