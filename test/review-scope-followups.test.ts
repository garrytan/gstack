/**
 * PR 2 of the /ship + /review convergence lane: the review-scope follow-ups
 * from PR 1's review notes. A Step 11 late defer is a review-log row that
 * counts under deferred and is not a pass; the deferred-issue search names its
 * page size and reads an exactly-full page as truncated; `gh repo view` takes
 * the repository positionally, so the visibility read works under --repo and a
 * MEDIUM finding on a public repository stays unfiled until a human confirms.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { ALREADY_FILED_REASON, LATE_DEFER_SKILL, renderDeferredSection, reviewLoopLine, summarizeReviewLoop } from '../lib/review-scope';
import { reviewFreshness } from '../lib/review-evidence';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo({ prefix: 'review-scope-2-' }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('late defers from Step 11', () => {
  test('a review-late-defer row adds its deferred findings, is not counted as a pass, and is invisible to review freshness', () => {
    const late = { skill: LATE_DEFER_SKILL, via: 'ship', timestamp: '2026-10-26T10:30:00Z', pass: 2, review_scope: 'frozen', findings: [
      { fingerprint: 'c:9:z', blocking: true, action: 'deferred', issue: null }, { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }] };
    const rows = [
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:00:00Z', pass: 1, review_scope: 'frozen', findings: [
        { fingerprint: 'a:1:x', blocking: true, action: 'auto-fixed' }, { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }] },
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:20:00Z', pass: 2, review_scope: 'frozen', findings: [] },
      late,
      { skill: 'adversarial-review', via: 'ship', timestamp: '2026-10-26T10:25:00Z', findings: [{ fingerprint: 'd:1:w', blocking: true, action: 'deferred' }] },
    ];
    const s = summarizeReviewLoop(rows, '2026-10-26T09:30:00Z');
    expect(s).toEqual({ passes: 2, blocking_found: 3, deferred: 2, noted: 0, fixed: 1, scope: 'frozen' });
    expect(reviewLoopLine(s)).toBe('REVIEW_LOOP: passes=2 blocking_found=3 deferred=2 noted=0 fixed=1 scope=frozen');
    expect(LATE_DEFER_SKILL).toBe('review-late-defer');
    // A `review` row logged without a start token would be the newest review row and read UNVERIFIED; the late-defer row is not a diff review at all.
    expect(reviewFreshness(late, 'abc')).toBeUndefined();
    expect(reviewFreshness({ ...late, skill: 'review' }, 'abc')?.status).toBe('UNVERIFIED');
  });
});

describe('deferred-issue search page and the repository argument gh accepts', () => {
  const finding = (fingerprint: string, summary: string) => {
    const [p, line, category] = fingerprint.split(':');
    return { fingerprint, path: p, line: Number(line), severity: 'CRITICAL', category, summary, locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' };
  };
  const shim = (repo: FixtureRepo, visibility: string, issues: number) => {
    const dir = path.join(repo.root, 'gh-shim');
    fs.mkdirSync(dir);
    const log = path.join(dir, 'calls.log');
    const page = JSON.stringify(Array.from({ length: issues }, (_, i) => ({ number: 100 + i, url: `https://example.test/acme/app/issues/${100 + i}`, body: `<!-- gstack-deferred-finding: other:${i}:x -->` })));
    fs.writeFileSync(path.join(dir, 'gh'), [
      '#!/bin/sh', `echo "$*" >> "${log}"`,
      `if [ "$1" = repo ] && [ "$2" = view ]; then [ "$3" = acme/app ] || { echo "gh: --repo not accepted by repo view: $*" >&2; exit 1; }; echo "${visibility}"; exit 0; fi`,
      `if [ "$1" = issue ] && [ "$2" = list ]; then cat <<'EOF'\n${page}\nEOF\nexit 0; fi`,
      'if [ "$1" = issue ] && [ "$2" = create ]; then echo "https://example.test/acme/app/issues/900"; exit 0; fi',
      'echo "unsupported $*" >&2; exit 1', '',
    ].join('\n'), { mode: 0o755 });
    return { dir, log };
  };

  // The gh stand-in is a sh script on a colon-joined PATH, which CreateProcess cannot run on Windows.
  test.skipIf(process.platform === 'win32')('an exactly-full search page is reported truncated and recorded on the issue it files; a short page is not', () => {
    const repo = fixture();
    const classified = path.join(repo.root, 'classified.json');
    fs.writeFileSync(classified, JSON.stringify([finding('lib/legacy.ts:7:data-loss', 'Unbounded delete')]));
    const full = shim(repo, 'PRIVATE', 200);
    const out = path.join(repo.root, 'deferred.json');
    const r = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--repo', 'acme/app', '--out', out, '--json'], { PATH: `${full.dir}:${process.env.PATH}` });
    expect(r.status).toBe(EXIT.ok);
    expect(r.err).toContain('DEFERRED_SEARCH: truncated at 200 open issues; an existing issue for a finding may not have been found');
    const records = JSON.parse(r.out);
    expect(records[0]).toMatchObject({ issue: 900, reason: 'filed; the marker search was truncated at 200, so an older issue may duplicate it' });
    expect(fs.readFileSync(full.log, 'utf8')).toContain('--limit 200');
    expect(renderDeferredSection(records)).toContain('- Deferred: #900 (filed; the marker search was truncated at 200, so an older issue may duplicate it) — CRITICAL `lib/legacy.ts:7` Unbounded delete');
    expect(renderDeferredSection([{ ...records[0], issue: 9, reason: ALREADY_FILED_REASON }])).toContain('- Deferred: #9 — CRITICAL `lib/legacy.ts:7` Unbounded delete');
    const repo2 = fixture();
    const short = shim(repo2, 'PRIVATE', 199);
    const r2 = runBin(repo2, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--repo', 'acme/app', '--json'], { PATH: `${short.dir}:${process.env.PATH}` });
    expect(r2.status).toBe(EXIT.ok);
    expect(r2.err).not.toContain('DEFERRED_SEARCH');
    expect(JSON.parse(r2.out)[0]).toEqual({ fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts:7', severity: 'CRITICAL', summary: 'Unbounded delete', issue: 900, url: 'https://example.test/acme/app/issues/900' });
  });

  test.skipIf(process.platform === 'win32')('with --repo the visibility read passes the repository positionally, so a MEDIUM finding on a public repository waits for a human and stays unfiled', () => {
    const repo = fixture();
    const classified = path.join(repo.root, 'classified.json');
    fs.writeFileSync(classified, JSON.stringify([
      finding('lib/mail.ts:3:pii', 'Notification goes to jane.roe@acme-corp.io on every retry'),
      finding('lib/legacy.ts:7:data-loss', 'Unbounded delete'),
    ]));
    const pub = shim(repo, 'PUBLIC', 0);
    const r = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--repo', 'acme/app', '--json'], { PATH: `${pub.dir}:${process.env.PATH}` });
    expect(r.status).toBe(EXIT.ok);
    const records = JSON.parse(r.out);
    expect(records[0].issue).toBeNull();
    expect(records[0].reason).toMatch(/^publication scan: MEDIUM pii\.email needs a human before this text is posted$/);
    expect(records[1]).toMatchObject({ issue: 900 });
    const calls = fs.readFileSync(pub.log, 'utf8');
    expect(calls).toContain('repo view acme/app --json visibility --jq .visibility');
    expect(calls).not.toMatch(/^repo view .*--repo/m);
    expect(calls.match(/^issue create /gm)?.length).toBe(1);
    expect(calls).not.toContain('jane.roe@acme-corp.io');
    expect(r.err).toContain('DEFERRED: unfiled (publication scan: MEDIUM pii.email needs a human before this text is posted) CRITICAL lib/mail.ts:3');
  });
});

describe('checklist rules with ids (docs/review-policy.md)', () => {
  const checklist = fs.readFileSync(path.resolve(import.meta.dir, '../review/checklist.md'), 'utf8');
  const policy = fs.readFileSync(path.resolve(import.meta.dir, '../docs/review-policy.md'), 'utf8');
  const section = (first: string, last: string) => checklist.slice(checklist.indexOf(first), checklist.indexOf(last));

  test('prereg-with-results is a Pass 1 gate-integrity ASK finding about the pairing, repaired by a split', () => {
    const gate = section('#### Gate Integrity', '#### Approval Classes and Data Repairs');
    expect(gate).toContain('`prereg-with-results`, ASK');
    expect(gate).toMatch(/preregistration .*results, scores or verdict/);
    expect(gate).toContain('the finding is the pairing, not either half');
    expect(gate).toMatch(/split them \(the preregistration lands first/);
    expect(policy).toContain('`prereg-with-results` (Pass 1, Gate Integrity, ASK)');
  });

  test('test-keyboard-count-loop is a Pass 2 informational rule that keeps a counted loop only when the count is the behavior', () => {
    const pass2 = section('### Pass 2 — check second', '## Sideways sweep');
    expect(pass2).toContain('#### Keyboard-Count Test Loops');
    expect(pass2).toContain('(`test-keyboard-count-loop`)');
    expect(pass2).toContain('Locate the target by role, label or test id');
    expect(pass2).toContain('a counted loop stays only when the count itself is the behavior under test');
    expect(policy).toContain('`test-keyboard-count-loop` (Pass 2, informational)');
    expect(policy).toContain('gstack-coauthor-trailers');
  });
});
