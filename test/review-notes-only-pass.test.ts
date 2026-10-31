/**
 * GST-430 (CAPY-2, qm#2837): a /ship review pass whose only findings were notes or deferrals has no
 * open defect, so the logger records it clean with issues_found 0 and Step 11.5 can bind it. A finding
 * still open (skipped, gate open, no action) keeps the claimed status. A row whose tree moved during
 * the pass names that cause and the cheapest repair.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isOpenFinding } from '../lib/headless-artifacts';
import { reviewFreshness } from '../lib/review-evidence';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-review-log');

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-notes-only-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function run(args: string[]) {
  const r = spawnSync(BIN, args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_HOME: home, GSTACK_SESSION_KIND: 'unattended' } });
  return { code: r.status, err: r.stderr, out: r.stdout };
}
function lastRow(): any {
  const projects = path.join(home, 'projects');
  const rows = fs.readdirSync(projects).flatMap(slug => fs.readdirSync(path.join(projects, slug)).filter(f => f.endsWith('-reviews.jsonl'))
    .flatMap(f => fs.readFileSync(path.join(projects, slug, f), 'utf8').trim().split('\n').map(l => JSON.parse(l))));
  return rows.at(-1);
}
const note = (i: number, action: string, extra: Record<string, unknown> = {}) =>
  ({ fingerprint: `lib/a.ts:${i}:testing`, severity: 'INFORMATIONAL', action, locus: 'diff', kind: 'test-gap', blocking: false, raised_by: 'specialist-batched', ...extra });
const pass = (findings: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  skill: 'review', via: 'ship', timestamp: '2026-10-31T00:00:00Z', status: 'issues_found', issues_found: findings.length, critical: 0,
  informational: findings.length, quality_score: 9, specialists: {}, findings, completed: true, converged: true, cycles: 0, pass: 2,
  review_scope: 'frozen', range_base: null, ...extra,
});

describe('a notes-only /ship review pass (GST-430)', () => {
  // Value: protects=Step 11.5 binding a pass whose 3 notes are not defects; catches=a notes-only pass logged as
  // issues_found and left UNVERIFIED, which cost CAPY-2 an extra rebind pass.
  test('three noted findings are recorded clean with 0 issues and read CURRENT', () => {
    const token = run(['--start', 'review']).out.trim();
    const r = run([pass([note(1, 'noted'), note(2, 'noted'), note(3, 'deferred', { issue: null })]), '--finish', token]);
    expect(r.code).toBe(0);
    const row = lastRow();
    expect([row.status, row.issues_found, row.critical, row.informational, row.review_binding.state]).toEqual(['clean', 0, 0, 0, 'verified']);
    expect(reviewFreshness(row, row.wtree)).toEqual({ status: 'CURRENT', reason: 'completed clean pass on unchanged content' });
  });

  // Value: protects=open defects still blocking 11.5; catches=a normalization that clears a skipped finding, a
  // gate finding the unattended logger forced open, a finding with no action, or an incomplete pass.
  test('negative controls keep issues_found', () => {
    const cases: Array<[string, string]> = [
      ['skipped', pass([note(1, 'noted'), note(2, 'skipped')])],
      ['gate open', pass([note(1, 'noted'), note(2, 'kept', { gate: 'RH1', gate_id: 'g', reason: 'r' })])],
      ['no action', pass([note(1, 'noted'), { fingerprint: 'lib/a.ts:9:testing', severity: 'CRITICAL' }])],
      ['incomplete', pass([note(1, 'noted')], { completed: false })],
      ['caller status over a stamped-open gate', pass([note(1, 'noted'), note(2, 'kept', { gate: 'RH1', gate_id: 'g', reason: 'r', severity: 'CRITICAL', status: 'resolved' })])],
      ['critical noted', pass([note(1, 'noted'), note(2, 'noted', { severity: 'CRITICAL' })])],
      ['blocking deferred', pass([note(1, 'noted'), note(2, 'deferred', { blocking: true, issue: null })])],
      ['counts beyond the findings', pass([note(1, 'noted')], { issues_found: 2, critical: 1 })],
      ['noted with no blocking field', pass([note(1, 'noted'), note(2, 'noted', { blocking: undefined })])],
    ];
    for (const [name, row] of cases) {
      expect(run([row]).code).toBe(0);
      expect([name, lastRow().status]).toEqual([name, 'issues_found']);
    }
  });

  // Value: protects=a claimed clean row cannot carry a gate finding the unattended logger stamped open past Step 11.5;
  //   catches=a reader that trusts the claimed status and counts over the stamped finding (red-team#2, pass 1).
  test('a claimed clean row with a stamped-open gate finding is not CURRENT', () => {
    const token = run(['--start', 'review']).out.trim();
    const gate = note(1, 'kept', { gate: 'RH1', gate_id: 'g', reason: 'r', severity: 'CRITICAL' });
    expect(run([pass([gate], { status: 'clean', issues_found: 0, critical: 0, informational: 0 }), '--finish', token]).code).toBe(0);
    const row = lastRow();
    expect([row.status, row.findings[0].action, row.review_binding.state]).toEqual(['clean', 'open', 'verified']);
    expect(reviewFreshness(row, row.wtree)?.status).toBe('UNVERIFIED');
  });

  // Value: protects=a claimed clean row reads open findings by the same rule the rewrite uses; catches=a CRITICAL
  //   deferral or a skipped finding under a claimed clean status reading CURRENT (adversarial-native#3, Step 11).
  test('a claimed clean row with a CRITICAL deferral or a skipped finding is not CURRENT', () => {
    const w = 'c'.repeat(40);
    const row = (findings: unknown[]) => ({ skill: 'review', status: 'clean', issues_found: 0, critical: 0, completed: true, converged: true, wtree: w,
      review_binding: { state: 'verified', start_wtree: w, end_wtree: w }, findings, status_source: 'claimed' });
    expect(reviewFreshness(row([note(1, 'deferred', { severity: 'CRITICAL', issue: null })]), w)?.status).toBe('UNVERIFIED');
    expect(reviewFreshness(row([note(1, 'skipped')]), w)?.status).toBe('UNVERIFIED');
    expect(reviewFreshness(row([note(1, 'noted')]), w)?.status).toBe('CURRENT');
  });

  // Value: protects=a findings file cannot dispose of a gate finding the unattended logger must force open; catches=gate rows
  //   from --findings derived as resolved without stamping (outside-voice#1, Step 11).
  test('a --findings file gate row is stamped open before its status is derived', () => {
    const file = path.join(home, 'findings.jsonl');
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, run: 'r', phase: 'review', voice: 'native', title: 't', fingerprint: 'lib/a.ts:1:x', severity: 'CRITICAL', action: 'auto-fixed', gate: 'RH1', gate_id: 'g' }) + '\n');
    const token = run(['--start', 'review']).out.trim();
    run([JSON.stringify({ skill: 'review', via: 'ship', timestamp: '2026-10-31T00:00:00Z', completed: true, converged: true }), '--findings', file, '--finish', token]);
    const row = lastRow();
    expect([row.findings_open, row.status === 'clean']).toEqual([1, false]);
    expect(reviewFreshness(row, row.wtree)?.status).not.toBe('CURRENT');
  });

  test('isOpenFinding: fixed and auto-fixed are not open; noted and deferred only below the floor; skipped and missing actions are', () => {
    expect(['fixed', 'auto-fixed', 'deferred', 'noted', 'skipped', undefined].map(action => isOpenFinding({ action, blocking: false })))
      .toEqual([false, false, false, false, true, true]);
    expect(['deferred', 'noted'].map(action => isOpenFinding({ action }))).toEqual([true, true]);
  });
});

describe('a tree that changed during the pass (GST-430)', () => {
  // Value: protects=a refusal that says why the record cannot bind and what the cheapest repair is; catches=the
  // bare 'content changed during review' that sent CAPY-2 through a ~$20 full pass without saying why.
  test('the STALE reason names both trees, the cause and the repair', () => {
    const s = 'a'.repeat(64), e = 'b'.repeat(64);
    const fresh = reviewFreshness({ skill: 'adversarial-review', review_binding: { state: 'changed', start_wtree: s, end_wtree: e } }, e);
    expect(fresh?.status).toBe('STALE');
    expect(fresh?.reason).toContain(`content changed during review: the tree moved from ${s.slice(0, 12)} to ${e.slice(0, 12)} while adversarial-review ran`);
    expect(fresh?.reason).toContain('freeze the checkout until every reviewer returns');
    expect(fresh?.reason).toContain('docs/troubleshooting.md#review-content-changed');
  });
});
