/**
 * Harness lane E: the /ship review loop's finding scope (lib/review-scope.ts,
 * bin/gstack-review-scope). Five Captains hit a loop that re-read the whole
 * diff each pass and fixed neighbours in pre-existing code until the cycle
 * cap. Under `review_scope: frozen` pass 1 fixes the diff and defers blocking
 * findings in unchanged code to issues; pass 2+ fixes only blocking findings
 * in the range since the previous pass (or the diff) and notes the rest.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import {
  isBlocking, kindOf, locusOf, parseHunks, raisedBy, renderDeferredIssue, renderDeferredSection, reviewLoopLine, scopeFindings, scopeLine, summarizeReviewLoop,
  type ScopedFinding,
} from '../lib/review-scope';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const ROOT = path.resolve(import.meta.dir, '..');

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo({ prefix: 'review-scope-' }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts', 'index 1..2 100644', '--- a/src/auth.ts', '+++ b/src/auth.ts',
  '@@ -10,2 +10,4 @@ export function check() {', '+  const a = 1;', '+  const b = 2;', '@@ -40 +42,0 @@', '-  old();',
  'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,3 @@', '+a', '+b', '+c',
  'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c',
].join('\n');

describe('hunk parsing and locus', () => {
  test('parseHunks reads new-side ranges, whole added files, untracked files, and keeps a deleted file as a whole changed location', () => {
    const hunks = parseHunks(DIFF, ['scratch/untracked.ts']);
    expect(hunks['src/auth.ts']).toEqual([[10, 13], [42, 42]]);
    expect(hunks['src/new.ts']).toBe('whole');
    expect(hunks['scratch/untracked.ts']).toBe('whole');
    expect(hunks['src/gone.ts']).toBe('whole');
  });

  // A removed export is a changed location: a caller it breaks reports the caller's path with a cause
  // in the deleted file, and the pass-4 outside review showed that anchor landed outside and deferred.
  test('a cause anchored in a deleted file is the diff, so the broken caller is fixed here, not deferred', () => {
    const diff = parseHunks(DIFF);
    expect(locusOf({ path: 'src/consumer.ts', line: 80, cause: { path: 'src/gone.ts', line: 2 } }, diff, null)).toBe('diff');
    const [scoped] = scopeFindings([{ fingerprint: 'src/consumer.ts:80:api', path: 'src/consumer.ts', line: 80, severity: 'CRITICAL', cause: { path: 'src/gone.ts' } }], { policy: 'frozen', pass: 1, diffHunks: diff, rangeHunks: null });
    expect(scoped!.locus).toBe('diff');
    expect(scoped!.scope).toBe('fix');
  });

  test('locusOf: inside a hunk or within 3 lines is the diff, farther is outside, an added file is whole, the range wins over the diff', () => {
    const diff = parseHunks(DIFF);
    expect(locusOf({ path: 'src/auth.ts', line: 11 }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'src/auth.ts', line: 16 }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'src/auth.ts', line: 17 }, diff, null)).toBe('outside');
    expect(locusOf({ path: 'src/auth.ts', line: 200 }, diff, null)).toBe('outside');
    expect(locusOf({ path: 'src/auth.ts' }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'src/new.ts', line: 999 }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'lib/other.ts', line: 1 }, diff, null)).toBe('outside');
    expect(locusOf({ fingerprint: 'src/auth.ts:11:security' }, diff, null)).toBe('diff');
    expect(locusOf({ fingerprint: 'shared-libs:abc' }, diff, null)).toBe('outside');
    expect(locusOf({ severity: 'CRITICAL', summary: 'somewhere' }, diff, null)).toBe('outside');
    // a defect the diff causes in an unchanged caller names the changed line in `cause`; the locus follows it
    expect(locusOf({ path: 'lib/caller.ts', line: 80, cause: { path: 'src/auth.ts', line: 11 } }, diff, null)).toBe('diff');
    expect(locusOf({ path: 'lib/caller.ts', line: 80, cause: { path: 'src/auth.ts', line: 300 } }, diff, null)).toBe('outside');
    expect(locusOf({ path: 'lib/caller.ts', line: 80, cause: { path: 'src/new.ts' } }, diff, null)).toBe('diff');
    const range = parseHunks('diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -11 +11 @@\n-x\n+y\n');
    expect(locusOf({ path: 'src/auth.ts', line: 11 }, diff, range)).toBe('fix-range');
    expect(locusOf({ path: 'src/auth.ts', line: 42 }, diff, range)).toBe('diff');
  });

  test('kind and the blocking floor: CRITICAL defects block; advisories, test gaps and INFORMATIONAL items never do', () => {
    expect(kindOf({ advisory: true, severity: 'INFORMATIONAL' })).toBe('advisory');
    expect(kindOf({ category: 'test-gap', severity: 'CRITICAL' })).toBe('test-gap');
    // the Testing specialist's schema (review/specialists/testing.md) emits category "testing" for every finding it returns
    const real = { severity: 'CRITICAL', confidence: 7, path: 'src/auth.ts', line: 42, category: 'testing', summary: 'denied path has no test', fingerprint: 'src/auth.ts:42:testing', specialist: 'testing' };
    expect(kindOf(real)).toBe('test-gap');
    expect(isBlocking(real)).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, 'review/specialists/testing.md'), 'utf8')).toContain('\"category\":\"testing\"');
    expect(kindOf({ category: 'security', severity: 'CRITICAL' })).toBe('defect');
    expect(isBlocking({ category: 'security', severity: 'CRITICAL' })).toBe(true);
    expect(isBlocking({ category: 'security', severity: 'critical' })).toBe(true);
    expect(isBlocking({ category: 'security', severity: 'INFORMATIONAL' })).toBe(false);
    expect(isBlocking({ category: 'test-coverage', severity: 'CRITICAL' })).toBe(false);
    expect(isBlocking({ advisory: true, severity: 'CRITICAL' })).toBe(false);
  });
});

describe('scope decisions', () => {
  const diff = parseHunks(DIFF);
  const range = parseHunks('diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -11 +11 @@\n-x\n+y\n');
  const findings = [
    { fingerprint: 'src/auth.ts:11:security', path: 'src/auth.ts', line: 11, severity: 'CRITICAL', category: 'security', summary: 'in range' },
    { fingerprint: 'src/auth.ts:42:logic', path: 'src/auth.ts', line: 42, severity: 'CRITICAL', category: 'logic', summary: 'in diff' },
    { fingerprint: 'src/auth.ts:42:naming', path: 'src/auth.ts', line: 42, severity: 'INFORMATIONAL', category: 'naming', summary: 'in diff, informational' },
    { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts', line: 7, severity: 'CRITICAL', category: 'data-loss', summary: 'pre-existing' },
    { fingerprint: 'lib/legacy.ts:9:style', path: 'lib/legacy.ts', line: 9, severity: 'INFORMATIONAL', category: 'style', summary: 'pre-existing wording' },
    { fingerprint: 'shared-libs:deadbeef', severity: 'INFORMATIONAL', advisory: true, category: 'shared-libs', summary: 'advice' },
  ];
  const by = (scoped: ScopedFinding[]) => Object.fromEntries(scoped.map(f => [f.fingerprint, `${f.locus}/${f.kind}/${f.blocking ? 'blocking' : 'below'}/${f.scope}`]));

  test('all: every finding is fixed, whatever its locus (the pre-frozen loop)', () => {
    const scoped = scopeFindings(findings, { policy: 'all', pass: 2, diffHunks: diff, rangeHunks: range });
    expect(scoped.every(f => f.scope === 'fix')).toBe(true);
    expect(by(scoped)['lib/legacy.ts:7:data-loss']).toBe('outside/defect/blocking/fix');
  });

  test('frozen pass 1: the diff is fixed, blocking findings outside are deferred, the rest are notes', () => {
    const scoped = scopeFindings(findings, { policy: 'frozen', pass: 1, diffHunks: diff, rangeHunks: range });
    expect(by(scoped)).toEqual({
      'src/auth.ts:11:security': 'diff/defect/blocking/fix',
      'src/auth.ts:42:logic': 'diff/defect/blocking/fix',
      'src/auth.ts:42:naming': 'diff/defect/below/fix',
      'lib/legacy.ts:7:data-loss': 'outside/defect/blocking/defer',
      'lib/legacy.ts:9:style': 'outside/defect/below/note',
      'shared-libs:deadbeef': 'outside/advisory/below/note',
    });
    expect(scopeLine('frozen', 1, scoped)).toBe('REVIEW_SCOPE: policy=frozen pass=1 findings=6 fix=3 defer=1 note=2 blocking=3');
    // a blocking finding nobody could place is fixed now, never filed against '(no path)'
    const unplaced = scopeFindings([{ severity: 'CRITICAL', category: 'logic', summary: 'somewhere' }], { policy: 'frozen', pass: 2, diffHunks: diff, rangeHunks: range });
    expect(by(unplaced)['undefined']).toBe('outside/defect/blocking/fix');
  });

  // Value: protects=below-floor findings from Step 11's voices or a fix-check are notes even when classified at --pass 1, so they never send the ship back through Steps 9-11; blocking ones stay fix; fails_when=Step 11 scopes its queue at PASS=1 and four below-floor notes come back `scope: fix` (GSTA-167 replay 8G on #34; CREW 23 and 30a);
  //   why_new=the frozen pass-1 case above has no raised_by; seam=scopeFindings; no_claim=that the parent tags raised_by correctly
  test('frozen pass 1: below-floor findings raised after pass 1 (Step 11, fix-check) are notes, blocking ones are fixed', () => {
    const late = (raised_by: string) => [
      { fingerprint: `src/auth.ts:42:naming:${raised_by}`, path: 'src/auth.ts', line: 42, severity: 'INFORMATIONAL', category: 'naming', summary: 'wording', raised_by },
      { fingerprint: `src/auth.ts:11:security:${raised_by}`, path: 'src/auth.ts', line: 11, severity: 'CRITICAL', category: 'security', summary: 'real', raised_by },
    ];
    for (const who of ['adversarial-native', 'adversarial', 'outside-voice', 'fix-check']) {
      const [below, blocker] = scopeFindings(late(who), { policy: 'frozen', pass: 1, diffHunks: diff, rangeHunks: range });
      expect([who, below!.scope, below!.locus]).toEqual([who, 'note', 'diff']);
      expect([who, blocker!.scope]).toEqual([who, 'fix']);
      expect(scopeFindings(late(who), { policy: 'diff-plus-blocking', pass: 1, diffHunks: diff, rangeHunks: range })[0]!.scope).toBe('note');
    }
    for (const who of ['core', 'red-team', 'qa', 'security']) expect(scopeFindings(late(who), { policy: 'frozen', pass: 1, diffHunks: diff, rangeHunks: range })[0]!.scope).toBe('fix');
    expect(scopeFindings(late('outside-voice'), { policy: 'all', pass: 1, diffHunks: diff, rangeHunks: range })[0]!.scope).toBe('fix');
  });

  test('diff-plus-blocking (the documented fallback, not the default): a blocking finding outside the diff is fixed here instead of filed; everything else is as frozen', () => {
    const p1 = by(scopeFindings(findings, { policy: 'diff-plus-blocking', pass: 1, diffHunks: diff, rangeHunks: range }));
    expect(p1['lib/legacy.ts:7:data-loss']).toBe('outside/defect/blocking/fix');
    expect(p1['lib/legacy.ts:9:style']).toBe('outside/defect/below/note');
    expect(p1['src/auth.ts:42:naming']).toBe('diff/defect/below/fix');
    const p2 = by(scopeFindings(findings, { policy: 'diff-plus-blocking', pass: 2, diffHunks: diff, rangeHunks: range }));
    expect(p2['lib/legacy.ts:7:data-loss']).toBe('outside/defect/blocking/fix');
    expect(p2['src/auth.ts:42:naming']).toBe('diff/defect/below/note');
    expect(Object.values(p2).some(v => String(v).endsWith('/defer'))).toBe(false);
  });

  test('frozen pass 2+: only blocking findings in the range or the diff are fixed; everything below the floor is a note', () => {
    const scoped = scopeFindings(findings, { policy: 'frozen', pass: 2, diffHunks: diff, rangeHunks: range });
    expect(by(scoped)).toEqual({
      'src/auth.ts:11:security': 'fix-range/defect/blocking/fix',
      'src/auth.ts:42:logic': 'diff/defect/blocking/fix',
      'src/auth.ts:42:naming': 'diff/defect/below/note',
      'lib/legacy.ts:7:data-loss': 'outside/defect/blocking/defer',
      'lib/legacy.ts:9:style': 'outside/defect/below/note',
      'shared-libs:deadbeef': 'outside/advisory/below/note',
    });
  });
});

describe('deferral rendering', () => {
  const finding: ScopedFinding = { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts', line: 7, severity: 'CRITICAL', category: 'data-loss', summary: 'Unbounded delete\nwithout a where clause', fix: 'add the tenant filter', specialist: 'security', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' };

  test('the issue names the origin PR, the finding and a marker that keeps a rerun from filing twice; the body section references and never closes', () => {
    const issue = renderDeferredIssue(finding, { repo: 'acme/app', pr: 42, branch: 'feat/x', head: 'a'.repeat(40) });
    expect(issue.title).toBe('Deferred review finding: lib/legacy.ts:7 — Unbounded delete without a where clause');
    expect(issue.body).toContain('acme/app#42 (head aaaaaaaaaaaa)');
    expect(issue.body).toContain('- **Severity:** CRITICAL');
    expect(issue.body).toContain('- **Suggested fix:** add the tenant filter');
    expect(issue.body).toContain('- **Found by:** security');
    expect(issue.marker).toBe('<!-- gstack-deferred-finding: lib/legacy.ts:7:data-loss -->');
    expect(issue.body.trimEnd().endsWith(issue.marker)).toBe(true);
    const section = renderDeferredSection(
      [{ fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts:7', severity: 'CRITICAL', summary: 'Unbounded delete', issue: 77 },
        { fingerprint: 'lib/old.ts:1:auth', path: 'lib/old.ts:1', severity: 'CRITICAL', summary: 'Missing owner check', issue: null, reason: 'gh is not installed' }],
      [{ path: 'src/auth.ts', line: 42, severity: 'INFORMATIONAL', summary: 'rename b', advisory: true }]);
    expect(section).toContain('## Deferred findings');
    expect(section).toContain('- Deferred: #77 — CRITICAL `lib/legacy.ts:7` Unbounded delete');
    expect(section).toContain('- Deferred: unfiled (gh is not installed) — CRITICAL `lib/old.ts:1` Missing owner check');
    expect(section).toContain('## Review notes');
    expect(section).toContain('- INFORMATIONAL [ADVISORY] `src/auth.ts:42` rename b');
    expect(section).not.toMatch(/\b(fixes|closes|resolves)\b/i);
    expect(renderDeferredSection([], [])).toBe('');
  });
});

describe('loop summary', () => {
  test('counts this invocation\'s passes and unique blocking, deferred, noted and fixed findings', () => {
    const rows = [
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:00:00Z', review_scope: 'frozen', findings: [
        { fingerprint: 'a:1:x', blocking: true, action: 'auto-fixed' }, { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }, { fingerprint: 'c:1:z', action: 'noted' }] },
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:30:00Z', review_scope: 'frozen', findings: [
        { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }, { fingerprint: 'c:1:z', action: 'noted' }] },
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T09:00:00Z', findings: [{ fingerprint: 'old:1:q', blocking: true, action: 'fixed' }] },
      { skill: 'adversarial-review', timestamp: '2026-10-26T10:15:00Z', findings: [{ fingerprint: 'd:1:w', blocking: true }] },
      { skill: 'review', timestamp: '2026-10-26T10:40:00Z', findings: [{ fingerprint: 'e:1:v', blocking: true }] },
    ];
    const s = summarizeReviewLoop(rows, '2026-10-26T09:30:00Z');
    expect(s).toEqual({ passes: 2, blocking_found: 2, deferred: 1, noted: 1, fixed: 1, scope: 'frozen' });
    expect(reviewLoopLine(s)).toBe('REVIEW_LOOP: passes=2 blocking_found=2 deferred=1 noted=1 fixed=1 scope=frozen');
  });

  // A pass logged without the template's timestamp (the logger stamps review_binding.started_at, never
  // timestamp) is still this invocation's pass; dropping it silently under-reported passes on #3481.
  test('a row dates from the logger\'s binding start before the writer\'s timestamp; a row with neither is not counted', () => {
    const rows = [
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:00:00Z', review_scope: 'frozen', findings: [{ fingerprint: 'a:1:x', blocking: true, action: 'auto-fixed' }] },
      { skill: 'review', via: 'ship', review_scope: 'frozen', review_binding: { state: 'changed', started_at: '2026-10-26T10:30:00.000Z' }, findings: [{ fingerprint: 'c:1:z', action: 'noted' }] },
      // A writer-typed date-only timestamp parses as midnight, before --since; the logger's start keeps the pass.
      { skill: 'review', via: 'ship', timestamp: '2026-10-26', review_binding: { state: 'verified', started_at: '2026-10-26T10:45:00.000Z' }, findings: [{ fingerprint: 'd:1:w', action: 'noted' }] },
      { skill: 'review', via: 'ship', review_binding: { state: 'changed', started_at: '2026-10-26T09:00:00.000Z' }, findings: [{ fingerprint: 'old:1:q', action: 'noted' }] },
      { skill: 'review', via: 'ship', findings: [{ fingerprint: 'undated:1:q', action: 'noted' }] },
    ];
    expect(summarizeReviewLoop(rows, '2026-10-26T09:30:00Z')).toEqual({ passes: 3, blocking_found: 1, deferred: 0, noted: 2, fixed: 1, scope: 'frozen' });
  });
});

describe('gstack-review-scope (bin)', () => {
  test('classify reads the branch diff and the pass range from git, honours the policy default, and refuses bad input with REVIEW_SCOPE_INPUT / REVIEW_SCOPE_RANGE', () => {
    const repo = fixture();
    const src = path.join(repo.work, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'legacy.ts'), Array.from({ length: 30 }, (_, i) => `legacy ${i + 1}`).join('\n') + '\n');
    fs.writeFileSync(path.join(src, 'auth.ts'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    const lines = fs.readFileSync(path.join(src, 'auth.ts'), 'utf8').split('\n');
    lines[9] = 'line 10 changed';
    fs.writeFileSync(path.join(src, 'auth.ts'), lines.join('\n'));
    repo.git('commit', '-qam', 'change line 10');
    const pass1Head = repo.git('rev-parse', 'HEAD');
    const findings = JSON.stringify([
      { fingerprint: 'src/auth.ts:10:logic', path: 'src/auth.ts', line: 10, severity: 'CRITICAL', category: 'logic', summary: 'wrong' },
      { fingerprint: 'src/auth.ts:25:logic', path: 'src/auth.ts', line: 25, severity: 'CRITICAL', category: 'logic', summary: 'neighbour' },
      { fingerprint: 'src/legacy.ts:3:security', path: 'src/legacy.ts', line: 3, severity: 'CRITICAL', category: 'security', summary: 'old' },
      { fingerprint: 'src/legacy.ts:4:style', path: 'src/legacy.ts', line: 4, severity: 'INFORMATIONAL', category: 'style', summary: 'wording' },
    ]);
    const f = path.join(repo.root, 'findings.json');
    fs.writeFileSync(f, findings);
    // diff.mnemonicPrefix prints c/ and w/ instead of a/ and b/; classify pins the prefixes, so the user's git config cannot send every finding outside.
    repo.git('config', 'diff.mnemonicPrefix', 'true');
    const p1 = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '1', '--findings', f, '--json']);
    expect(p1.status).toBe(EXIT.ok);
    expect(p1.err.trim()).toBe('REVIEW_SCOPE: policy=frozen pass=1 findings=4 fix=1 defer=2 note=1 blocking=3');
    const j1 = JSON.parse(p1.out);
    expect(j1.policy).toBe('frozen');
    expect(j1.findings.map((x: ScopedFinding) => `${x.fingerprint}=${x.locus}/${x.scope}`)).toEqual([
      'src/auth.ts:10:logic=diff/fix', 'src/auth.ts:25:logic=outside/defer', 'src/legacy.ts:3:security=outside/defer', 'src/legacy.ts:4:style=outside/note']);
    // pass 1 "fixed" line 10 and touched line 25 (a regression in the fix range)
    lines[9] = 'line 10 fixed'; lines[24] = 'line 25 touched by the fix';
    fs.writeFileSync(path.join(src, 'auth.ts'), lines.join('\n'));
    repo.git('commit', '-qam', 'fix: pre-landing review fixes');
    const p2 = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '2', '--range-base', pass1Head, '--findings', f, '--json']);
    expect(p2.status).toBe(EXIT.ok);
    expect(JSON.parse(p2.out).findings.map((x: ScopedFinding) => `${x.fingerprint}=${x.locus}/${x.scope}`)).toEqual([
      'src/auth.ts:10:logic=fix-range/fix', 'src/auth.ts:25:logic=fix-range/fix', 'src/legacy.ts:3:security=outside/defer', 'src/legacy.ts:4:style=outside/note']);
    const all = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '2', '--range-base', pass1Head, '--policy', 'all', '--findings', f, '--json']);
    expect(JSON.parse(all.out).findings.every((x: ScopedFinding) => x.scope === 'fix')).toBe(true);
    const noRange = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '2', '--findings', f]);
    expect(noRange.status).toBe(EXIT.fail);
    expect(noRange.err).toContain('(REVIEW_SCOPE_INPUT;');
    const badRange = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '2', '--range-base', 'f'.repeat(40), '--findings', f]);
    expect(badRange.status).toBe(EXIT.fail);
    expect(badRange.err).toContain('(REVIEW_SCOPE_RANGE;');
    // a --range-base on pass 1 is not applied, so the envelope does not claim it
    const p1Range = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '1', '--range-base', pass1Head, '--findings', f, '--json']);
    expect(JSON.parse(p1Range.out).range_base).toBeNull();
    for (const args of [['--pass', '0'], ['--pass', '1', '--policy', 'loose'], ['--pass', '2', '--range-base', '--output=/tmp/x']]) {
      const r = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', ...args, '--findings', f]);
      expect(r.status).toBe(EXIT.fail);
      expect(r.err).toContain('(REVIEW_SCOPE_INPUT;');
    }
    // the reviewed policy is the base's; an unresolvable base is refused by name, never read from the working tree
    const noBase = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'nonesuch', '--pass', '1', '--findings', f]);
    expect(noBase.status).toBe(EXIT.refused);
    expect(noBase.err).toContain('(POLICY_SOURCE_UNAVAILABLE)');
    expect(noBase.err).toContain('pass --policy to classify without the base');
    fs.writeFileSync(f, '{"not":"an array"}');
    const bad = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '1', '--findings', f]);
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain('(REVIEW_SCOPE_INPUT;');
    const d = path.join(repo.root, 'deferred.json'); fs.writeFileSync(d, '{}');
    const badRender = runBin(repo, 'gstack-review-scope', ['render', '--deferred', d]);
    expect(badRender.status).toBe(EXIT.fail);
    expect(badRender.err).toContain('expected the JSON array defer --out writes');
  });

  test('classify sees a non-ASCII changed path under its own name, so a CRITICAL finding there is fixed, not deferred to an issue', () => {
    const repo = fixture();
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'café.ts'), 'export const a = 1;\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'src', 'café.ts'), 'export const a = 2;\n');
    repo.git('commit', '-qam', 'change');
    fs.writeFileSync(path.join(repo.work, 'src', 'naïve.ts'), 'export const n = 1;\n');
    const f = path.join(repo.root, 'findings.json');
    fs.writeFileSync(f, JSON.stringify([
      { path: 'src/café.ts', line: 1, severity: 'CRITICAL', category: 'logic', summary: 'wrong' },
      { path: 'src/naïve.ts', line: 1, severity: 'CRITICAL', category: 'logic', summary: 'untracked' },
    ]));
    const r = runBin(repo, 'gstack-review-scope', ['classify', '--base', 'main', '--pass', '1', '--findings', f, '--json']);
    expect(r.status).toBe(EXIT.ok);
    expect(JSON.parse(r.out).findings.map((x: ScopedFinding) => `${x.path}=${x.locus}/${x.scope}`)).toEqual(['src/café.ts=diff/fix', 'src/naïve.ts=diff/fix']);
  });

  test('defer without gh keeps the finding deferred as unfiled and still exits 0 (the PR body carries the reason), searches once before creating, and files nothing when the search fails; --dry-run files nothing', () => {
    const repo = fixture();
    const classified = path.join(repo.root, 'classified.json');
    fs.writeFileSync(classified, JSON.stringify([
      { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts', line: 7, severity: 'CRITICAL', category: 'data-loss', summary: 'Unbounded delete', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' },
      { fingerprint: 'src/auth.ts:42:naming', path: 'src/auth.ts', line: 42, severity: 'INFORMATIONAL', category: 'naming', summary: 'rename b', locus: 'diff', kind: 'defect', blocking: false, scope: 'note' },
      { fingerprint: 'src/auth.ts:11:security', path: 'src/auth.ts', line: 11, severity: 'CRITICAL', category: 'security', summary: 'fixed', locus: 'diff', kind: 'defect', blocking: true, scope: 'fix' },
    ]));
    const dry = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--dry-run', '--json']);
    expect(dry.status).toBe(EXIT.ok);
    expect(JSON.parse(dry.out)).toEqual([{ fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts:7', severity: 'CRITICAL', summary: 'Unbounded delete', issue: null, reason: 'dry run' }]);
    const noGh = path.join(repo.root, 'nogh');
    fs.mkdirSync(noGh);
    fs.writeFileSync(path.join(noGh, 'gh'), '#!/bin/sh\necho "gh: not logged in" >&2; exit 4\n', { mode: 0o755 });
    const out = path.join(repo.root, 'deferred.json');
    const unfiled = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--out', out], { PATH: `${noGh}:${process.env.PATH}` });
    expect(unfiled.status).toBe(EXIT.ok);
    expect(unfiled.err).toMatch(/^DEFERRED: unfiled \(gh issue list failed: gh: not logged in\) CRITICAL lib\/legacy\.ts:7$/m);
    expect(unfiled.out).toContain('- Deferred: unfiled (gh issue list failed: gh: not logged in) — CRITICAL `lib/legacy.ts:7` Unbounded delete');
    // the search failed, so nothing was created: a rate-limited rerun cannot duplicate the issue the marker exists to find
    const listFails = path.join(repo.root, 'listfails');
    fs.mkdirSync(listFails);
    const created = path.join(listFails, 'created');
    fs.writeFileSync(path.join(listFails, 'gh'), `#!/bin/sh\nif [ "$1" = issue ] && [ "$2" = list ]; then echo "gh: HTTP 403 rate limit" >&2; exit 1; fi\nif [ "$1" = issue ] && [ "$2" = create ]; then touch "${created}"; echo https://example.test/o/r/issues/1; exit 0; fi\nexit 1\n`, { mode: 0o755 });
    const rateLimited = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--json'], { PATH: `${listFails}:${process.env.PATH}` });
    expect(rateLimited.status).toBe(EXIT.ok);
    expect(JSON.parse(rateLimited.out)[0]).toMatchObject({ issue: null, reason: 'gh issue list failed: gh: HTTP 403 rate limit' });
    expect(fs.existsSync(created)).toBe(false);
    const rendered = runBin(repo, 'gstack-review-scope', ['render', '--deferred', out, '--findings', classified]);
    expect(rendered.status).toBe(EXIT.ok);
    expect(rendered.out).toContain('## Deferred findings');
    expect(rendered.out).toContain('## Review notes');
    expect(rendered.out).toContain('- INFORMATIONAL `src/auth.ts:42` rename b');
    expect(rendered.out).not.toContain('src/auth.ts:11');
  });

  test('defer through gh creates one issue per deferred finding and reuses an open issue that already carries the marker', () => {
    const repo = fixture();
    const shim = path.join(repo.root, 'gh-shim');
    fs.mkdirSync(shim);
    const log = path.join(shim, 'calls.log');
    fs.writeFileSync(path.join(shim, 'gh'), [
      '#!/bin/sh', `echo "$*" >> "${log}"`,
      'if [ "$1" = issue ] && [ "$2" = list ]; then',
      `  echo '[{"number":9,"url":"https://example.test/acme/app/issues/9","body":"x <!-- gstack-deferred-finding: lib/legacy.ts:7:data-loss --> y"},{"number":3,"url":"https://example.test/acme/app/issues/3","body":"<!-- gstack-deferred-finding: other:1:x -->"}]'; exit 0; fi`,
      'if [ "$1" = issue ] && [ "$2" = create ]; then echo "https://example.test/acme/app/issues/10"; exit 0; fi',
      'echo "unsupported $*" >&2; exit 1', '',
    ].join('\n'), { mode: 0o755 });
    const classified = path.join(repo.root, 'classified.json');
    fs.writeFileSync(classified, JSON.stringify([
      { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts', line: 7, severity: 'CRITICAL', category: 'data-loss', summary: 'Unbounded delete', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' },
      { fingerprint: 'lib/old.ts:1:auth', path: 'lib/old.ts', line: 1, severity: 'CRITICAL', category: 'auth', summary: 'Missing owner check', fix: 'check owner', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' },
      // Reviewer text is untrusted: a security finding that quotes the credential it found must not reach a public issue.
      { fingerprint: 'lib/keys.ts:3:security', path: 'lib/keys.ts', line: 3, severity: 'CRITICAL', category: 'security', summary: 'Hardcoded token ghp_' + 'Qm4zR7tK2wX9pL5vN8sD1fG6hJ3yB0cA7eU2', locus: 'outside', kind: 'defect', blocking: true, scope: 'defer' },
    ]));
    const r = runBin(repo, 'gstack-review-scope', ['defer', '--findings', classified, '--pr', '42', '--repo', 'acme/app', '--json'], { PATH: `${shim}:${process.env.PATH}` });
    expect(r.status).toBe(EXIT.ok);
    const records = JSON.parse(r.out);
    expect(records.slice(0, 2)).toEqual([
      { fingerprint: 'lib/legacy.ts:7:data-loss', path: 'lib/legacy.ts:7', severity: 'CRITICAL', summary: 'Unbounded delete', issue: 9, url: 'https://example.test/acme/app/issues/9', reason: 'already filed' },
      { fingerprint: 'lib/old.ts:1:auth', path: 'lib/old.ts:1', severity: 'CRITICAL', summary: 'Missing owner check', issue: 10, url: 'https://example.test/acme/app/issues/10' },
    ]);
    expect(records[2].issue).toBeNull();
    expect(records[2].reason).toMatch(/^publication scan refused: HIGH /);
    expect(r.err).toContain('DEFERRED: #9 CRITICAL lib/legacy.ts:7');
    expect(r.err).toContain('DEFERRED: #10 CRITICAL lib/old.ts:1');
    expect(r.err).toContain('DEFERRED: unfiled (publication scan refused: HIGH ');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls.match(/^issue create /gm)?.length).toBe(1);
    expect(calls.match(/^issue list /gm)?.length).toBe(1);
    expect(calls).toContain('--search "gstack-deferred-finding" in:body');
    expect(calls).toContain('issue create --title=Deferred review finding: lib/old.ts:1 — Missing owner check --body-file=- --repo acme/app');
    expect(calls).not.toContain('Qm4zR7tK2wX9pL5vN8sD1fG6hJ3yB0cA7eU2');
  });

  // Generated by /ship Step 7 (coverage audit of the harness lane E diff).
  // Value: protects=summary reads this branch's review log through gstack-review-read and prints the REVIEW_LOOP counters that
  // `gstack-ship-receipt write --review-loop` consumes, counting only this invocation's ship-via review passes and tolerating a
  // malformed row and a branch with no log; fails_when=the row filter, the ---CONFIG--- split, the --since guard or the --out
  // write breaks, or a missing log is treated as an error instead of zero passes; why_new=only the pure summarizeReviewLoop is
  // tested, never the bin against a review log on disk; seam=none; no_claim=review-log writing (rows are written directly, not
  // through gstack-review-log)
  test('summary reads the branch review log through gstack-review-read, counts this invocation\'s passes, writes --out, and refuses a missing --since', () => {
    const repo = fixture();
    repo.git('checkout', '-qb', 'feat');
    const slug = runBin(repo, 'gstack-slug', ['--get', 'SLUG']).out.trim();
    const branch = runBin(repo, 'gstack-slug', ['--get', 'BRANCH']).out.trim();
    expect(slug).not.toBe('');
    expect(branch).toBe('feat');
    const logDir = path.join(repo.home, 'projects', slug);
    fs.mkdirSync(logDir, { recursive: true });
    const rows = [
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T09:00:00Z', status: 'clean', review_scope: 'frozen', findings: [{ fingerprint: 'old:1:q', blocking: true, action: 'fixed' }] },
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:00:00Z', status: 'issues_found', review_scope: 'frozen', findings: [
        { fingerprint: 'a:1:x', blocking: true, action: 'auto-fixed' }, { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }, { fingerprint: 'c:1:z', action: 'noted' }] },
      { skill: 'adversarial-review', via: 'ship', timestamp: '2026-10-26T10:15:00Z', findings: [{ fingerprint: 'd:1:w', blocking: true }] },
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:30:00Z', status: 'clean', review_scope: 'frozen', findings: [
        { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }, { fingerprint: 'c:1:z', action: 'noted' }] },
      { skill: 'review', timestamp: '2026-10-26T10:40:00Z', findings: [{ fingerprint: 'e:1:v', blocking: true, action: 'fixed' }] },
    ];
    fs.writeFileSync(path.join(logDir, `${branch}-reviews.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n{not json\n');
    const expected = { passes: 2, blocking_found: 2, deferred: 1, noted: 1, fixed: 1, scope: 'frozen' };
    const out = path.join(repo.root, 'review-loop.json');
    const r = runBin(repo, 'gstack-review-scope', ['summary', '--since', '2026-10-26T09:30:00Z', '--out', out, '--json']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.err).toContain('REVIEW_LOOP: passes=2 blocking_found=2 deferred=1 noted=1 fixed=1 scope=frozen');
    expect(JSON.parse(r.out)).toEqual(expected);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(expected);
    const plain = runBin(repo, 'gstack-review-scope', ['summary', '--since', '2026-10-26T08:00:00Z']);
    expect(plain.status).toBe(EXIT.ok);
    expect(plain.out.trim()).toBe('REVIEW_LOOP: passes=3 blocking_found=3 deferred=1 noted=1 fixed=2 scope=frozen');
    const noSince = runBin(repo, 'gstack-review-scope', ['summary', '--json']);
    expect(noSince.status).toBe(EXIT.fail);
    expect(noSince.err).toContain('(REVIEW_SCOPE_INPUT;');
    expect(noSince.out).toBe('');
    const badSince = runBin(repo, 'gstack-review-scope', ['summary', '--since', 'yesterday']);
    expect(badSince.status).toBe(EXIT.fail);
    expect(badSince.err).toContain('(REVIEW_SCOPE_INPUT;');
    // zero matching passes is a wrong --since or a log written elsewhere, never a loop to record: refused, nothing written
    const bare = fixture();
    const noneOut = path.join(bare.root, 'review-loop.json');
    const none = runBin(bare, 'gstack-review-scope', ['summary', '--since', '2026-10-26T09:30:00Z', '--out', noneOut, '--json']);
    expect(none.status).toBe(EXIT.fail);
    expect(none.err).toContain('(REVIEW_SCOPE_INPUT;');
    expect(none.err).toContain('REVIEW_LOOP: passes=0');
    expect(fs.existsSync(noneOut)).toBe(false);
    const late = runBin(repo, 'gstack-review-scope', ['summary', '--since', '2026-10-27T00:00:00Z']);
    expect(late.status).toBe(EXIT.fail);
  });
});

describe('raised_by: which reviewer raised a classified finding (GSTA-152 D6)', () => {
  test.each([
    [{ raised_by: 'red-team' }, 'red-team'], [{ raised_by: 'QA' }, 'qa'], [{ raised_by: 'core' }, 'core'], [{ raised_by: 'fix-check' }, 'fix-check'],
    [{ specialist: 'State Machines' }, 'state-machines'], [{ specialist: 'red-team' }, 'red-team'], [{ specialist: 'adversarial' }, 'adversarial-native'],
    [{ specialist: 'outside-voice' }, 'outside-voice'], [{ raised_by: 'nonsense\n', specialist: 'testing' }, 'testing'], [{ specialist: 42 }, 'unknown'], [{}, 'unknown'],
  ])('%j -> %s', (f, want) => expect(raisedBy(f as any)).toBe(want));
  test('classify stamps raised_by on every finding, and an older row without it still summarizes', () => {
    const scoped = scopeFindings([{ fingerprint: 'src/a.ts:3:logic', path: 'src/a.ts', line: 3, severity: 'CRITICAL', specialist: 'security' }, { fingerprint: 'src/a.ts:9:logic', path: 'src/a.ts', line: 9, severity: 'CRITICAL' }], { policy: 'frozen', pass: 1, diffHunks: { 'src/a.ts': 'whole' }, rangeHunks: null });
    expect(scoped.map(f => f.raised_by)).toEqual(['security', 'unknown']);
    const old = { skill: 'review', via: 'ship', timestamp: '2026-10-28T10:00:00Z', findings: [{ fingerprint: 'src/a.ts:3:logic', blocking: true, action: 'fixed' }] };
    expect(summarizeReviewLoop([old], '2026-10-28T09:00:00Z')).toMatchObject({ passes: 1, blocking_found: 1, fixed: 1 });
  });
});
