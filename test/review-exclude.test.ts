/**
 * review_exclude_paths and the reviewer diff ceiling (GST-508, docs/ship-policy.md#review-exclude-paths): what the base
 * policy excludes and keeps, what every brief's diff commands read, the receipt binding, the base-policy read, the
 * argument-byte bound and the REVIEW_DIFF_TOO_LARGE / REVIEW_DIFF_UNREADABLE lines.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { KEEP_ARG_MAX_BYTES, readSelection, reviewExclude, tooLargeLine, unreadableLine } from '../lib/review-exclude';
import { collectCommit, collectLive } from '../lib/review-collect';
import { extractReceipt } from '../lib/ship-receipt';
import { bindShippedReceipt, excludeMismatch, receiptReviewAtHead } from '../lib/ship-receipt-depth';
import { REVIEW_EXCLUDE_KEY_VERSION, isUnavailable } from '../lib/ship-policy';
import { loadPolicyAt } from '../lib/ship-policy-at';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const policyText = (patterns: string[]) => JSON.stringify({ review_exclude_paths: patterns, min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';
const GZ = Buffer.from([0x1f, 0x8b, 0, 1, 2, 3, 0, 0]);
const EXCLUDED = ['receipts/a/result.json', 'receipts/a/trial.gz', 'receipts/config/blob.bin', 'receipts/c/result.json', 'receipts/e/result.json', 'receipts/notes.md'];
const KEPT = ['receipts/b/result.json', 'receipts/d/fixture.json', 'receipts/run.sh'];

/** A results branch: receipts/** on the base policy, receipts of every kind on the branch. */
function census(patterns: string[] | null = ['receipts/**']): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: patterns ? { '.gstack/ship-policy.json': policyText(patterns) } : {} });
  repos.push(repo);
  for (const [rel, bytes] of [['receipts/a/trial.gz', GZ], ['receipts/config/blob.bin', GZ]] as const) {
    fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo.work, rel), bytes);
  }
  write(repo.work, 'receipts/run.sh', '#!/bin/sh\necho run\n');
  fs.chmodSync(path.join(repo.work, 'receipts/run.sh'), 0o755);
  repo.git('add', 'receipts/run.sh');
  repo.git('update-index', '--chmod=+x', 'receipts/run.sh');
  commit(repo, {
    'receipts/a/result.json': '{"cost_usd": 12.5, "pass_rate": "97%"}\n',
    'receipts/b/result.json': '{"ok": true}\n',
    'receipts/c/result.json': '{"ok": true}\n',
    'receipts/d/fixture.json': '{"ok": true}\n',
    'receipts/e/result.json': '{"ok": true}\n',
    'receipts/notes.md': '# notes\n',
    'docs/receipts-manifest.json': JSON.stringify(['receipts/c/result.json', 'receipts/a/trial.gz']) + '\n',
    'lib/reader.js': "exports.p = 'receipts/b/result.json';\nexports.q = 'result.json';\n",
    'test/d.test.js': "const f = 'receipts/d/fixture.json';\n",
  });
  return repo;
}
const plan = (repo: FixtureRepo, extra: string[] = []) => runBin(repo, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', ...extra]);
const mergeBase = (repo: FixtureRepo) => repo.git('merge-base', 'origin/main', 'HEAD');
/** The paths one diff command from a plan line or a brief reads (run as --name-only in the fixture). */
function pathsRead(repo: FixtureRepo, cmd: string, diffBase: string): string[] {
  const named = cmd.replace(/^git diff( --stat| --name-status)?/, 'git diff --name-only').replace('<diff-base>', '"$DIFF_BASE"');
  const r = spawnSync('bash', ['-c', named], { cwd: repo.work, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...repo.env, DIFF_BASE: diffBase } });
  expect({ cmd: named, status: r.status, err: r.stderr }).toMatchObject({ cmd: named, status: 0 });
  return r.stdout.split('\n').filter(Boolean);
}
/** Rewrite the base: commit on main, push, and merge it into the feature branch. */
function onBase(repo: FixtureRepo, files: Record<string, string>) {
  repo.git('checkout', '-q', 'main');
  commit(repo, files, 'base change');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('fetch', '-q', 'origin');
  repo.git('merge', '-q', '--no-edit', 'origin/main');
}

describe('what review_exclude_paths excludes and keeps', () => {
  // Value: protects=a results PR's receipts leave the reviewers' diff while code, executables and files a program names stay;
  //   fails_when=a binary file under config/ is kept, a file named only by a data manifest or by its basename is kept, or a
  //   file a test names by full path is excluded; why_new=GST-508 adds the selection; seam=bin/gstack-review-plan on a real
  //   repository and git running the printed commands; no_claim=references by relative path or directory (REVIEW_EXCLUDE_REFERENCE)
  test('binary, data and docs files are excluded; only a code or test file naming the full path keeps one', () => {
    const repo = census();
    const p = JSON.parse(plan(repo, ['--json']).out);
    expect(p.review_exclude.kept_files).toEqual([
      { path: 'receipts/b/result.json', reason: 'named-by-code' },
      { path: 'receipts/d/fixture.json', reason: 'named-by-code' },
      { path: 'receipts/run.sh', reason: 'executable' },
    ]);
    expect(p.review_exclude).toMatchObject({ state: 'active', excluded: EXCLUDED.length, content: { binary: 2, data: 3, docs: 1, log: 0 } });
    const text = plan(repo).out;
    expect(text).toContain(`REVIEW_EXCLUDE: patterns=1/1 excluded=${EXCLUDED.length} `);
    expect(text).toContain(' content=binary:2,data:3,docs:1 ');
    const mb = mergeBase(repo);
    const cmds = text.split('\n').filter(l => /^DIFF_(CMD|KEEP): /.test(l)).map(l => l.replace(/^DIFF_(CMD|KEEP): \S+ /, ''));
    expect(cmds.length).toBeGreaterThan(2);
    const read = new Set(cmds.flatMap(c => pathsRead(repo, c, mb)));
    for (const f of EXCLUDED) expect(read.has(f)).toBe(false);
    for (const f of KEPT) expect(read.has(f)).toBe(true);
  }, 120_000);

  // Value: protects=the Red Team, the security specialist, the adversarial pass and the outside voice read the same selection
  //   as the plan, including through the fixture-handling command; fails_when=any brief's git diff command (or the embedded
  //   outside-voice diff) shows an excluded file, or a kept file is unreachable from a brief; why_new=task 8 (the fixture
  //   command had no exclude slot); seam=gstack-review-dispatch pass/stage/render and git; no_claim=what a model does with the brief
  test('every brief\'s git diff commands leave excluded files out and reach the kept ones', () => {
    const repo = census();
    const out = path.join(repo.root, 'pass');
    expect(runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', out, '--pass', 'p1', '--', '--gate-tagged', '0']).status).toBe(EXIT.ok);
    expect(runBin(repo, 'gstack-review-dispatch', ['stage', '--manifest', path.join(out, 'pass-manifest.json'), '--stage', 'voices']).status).toBe(EXIT.ok);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8'));
    const reader = m.readers.find((r: any) => r.role === 'adversarial-native');
    const mb = mergeBase(repo);
    const slots = ['--base', 'main', '--diff-base', mb, '--exclude', reader.exclude, '--keep', ['--', ...reader.keep.map((k: string) => `'${k}'`)].join(' '), '--disclosure', m.disclosure];
    for (const role of [['specialist', '--name', 'security'], ['red-team', '--specialists', '1'], ['outside-voice']]) {
      const r = runBin(repo, 'gstack-review-dispatch', ['render', '--role', ...role, '--out', path.join(out, 'briefs'), ...slots]);
      expect(r.status).toBe(EXIT.ok);
    }
    const briefs = fs.readdirSync(path.join(out, 'briefs')).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(out, 'briefs', f), 'utf8'));
    expect(briefs.length).toBe(5);
    const cmds = [...new Set(briefs.flatMap(b => [...b.matchAll(/`[^`\n]*?(git diff [^`\n]*)`/g)].map(x => x[1]!)))];
    expect(cmds.some(c => c.includes("'*fixture*'"))).toBe(true);
    const read = new Set(cmds.flatMap(c => pathsRead(repo, c, mb)));
    for (const f of EXCLUDED) expect(read.has(f)).toBe(false);
    for (const f of KEPT) expect(read.has(f)).toBe(true);
    const outside = briefs.find(b => b.includes('## Branch diff'))!;
    expect(outside).toContain(`git diff "$DIFF_BASE" -- . ${m.readers[0].policy_exclude} and git diff "$DIFF_BASE" -- '${reader.keep[0]}'`);
    const diffFile = path.join(out, 'briefs', 'outside-voice.diff');
    expect(outside).toContain(`The supplied branch diff is the file ${diffFile} `);
    const supplied = fs.readFileSync(diffFile, 'utf8');
    for (const f of EXCLUDED) expect(supplied).not.toContain(`diff --git a/${f}`);
    expect(supplied).toContain('diff --git a/receipts/b/result.json');
    for (const b of briefs) expect(b).toContain(`(selection ${m.review_exclude.digest})`);
  }, 180_000);

  // Value: protects=Step 11's standalone targeted render cannot record a brief with no selection beside the pass's briefs;
  //   fails_when=render --role targeted without --disclosure writes a rendered event with no exclude digest, so verify sees
  //   mixed digests and never prints VERIFY: clean; why_new=/ship review of the GST-508 wave (Red Team); seam=gstack-review-dispatch render
  test('a standalone targeted render under an active exclusion refuses and leaves the ledger as the pass wrote it', () => {
    const repo = census();
    const out = path.join(repo.root, 'pass');
    expect(runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', out, '--pass', 'p1', '--', '--gate-tagged', '0']).status).toBe(EXIT.ok);
    const ledger = path.join(out, 'review-ledger.jsonl');
    const before = fs.readFileSync(ledger, 'utf8');
    const r = runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', 'money', '--base', 'main', '--diff-base', mergeBase(repo), '--out', out]);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain("review_exclude_paths is active, so the targeted reader renders in the pass manifest's voices stage");
    expect(fs.readFileSync(ledger, 'utf8')).toBe(before);
  }, 120_000);

  // Value: protects=excluded receipts cannot dispatch the outside voice or the targeted money reader on lines no reader sees,
  //   and a credential line inside a matched file keeps it; fails_when=scanNumbers or targetedClasses read excluded lines, or
  //   a secret-bearing data file is excluded; why_new=task 9; seam=bin/gstack-review-plan; no_claim=pregate's credential scan
  test('excluded lines feed neither the numeric scan nor the targeted classes; a credential line keeps its file', () => {
    const files = { 'receipts/r.json': '{"cost_usd": 12.5, "price_usd": 3, "pass_rate": "97%", "latency_ms": 180}\n', 'docs/bench.md': '# bench\n', 'receipts/s.json': '{"cmd": "curl -H $OPENAI_API_KEY"}\n' };
    const control = makeFixtureRepo({ prefix: 'gstack-exclude-' }); repos.push(control);
    commit(control, files);
    const with_ = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['receipts/**']) } }); repos.push(with_);
    commit(with_, files);
    const c = JSON.parse(plan(control, ['--json']).out);
    const w = JSON.parse(plan(with_, ['--json']).out);
    expect(c.numbers.publishes).toBe(true);
    // HARN-1 (harness-evals#231): a JSON data file is judged by its path, so cost_usd names no money even unexcluded; its secret line still counts
    expect(c.targeted.classes).toEqual(['secret']);
    expect(w.review_exclude.kept_files).toEqual([{ path: 'receipts/s.json', reason: 'secret-line' }]);
    expect(w.numbers.publishes).toBe(false);
    expect(w.targeted.classes).toEqual(['secret']);
  }, 120_000);
});

describe('the base policy read', () => {
  // Value: protects=a base the plan cannot read never turns exclusion off quietly; fails_when=a missing blob or a bad commit
  //   reads as no policy, or an invalid base key plans without exclusion; why_new=task 6; seam=loadPolicyAt and the plan CLI;
  //   no_claim=the head copy's validation (gstack-ship-policy validate)
  test('no file reads as defaults; an unreadable object or commit is unavailable; an invalid base key refuses the plan', () => {
    const none = census(null);
    const sha = none.git('rev-parse', 'origin/main');
    const absent = loadPolicyAt(none.work, sha, 'origin/main');
    expect(isUnavailable(absent)).toBe(false);
    expect(!isUnavailable(absent) && absent.policy.review_exclude_paths).toEqual([]);
    expect(isUnavailable(loadPolicyAt(none.work, 'f'.repeat(40), 'origin/main'))).toBe(true);

    const gone = census();
    const blob = gone.git('rev-parse', 'origin/main:.gstack/ship-policy.json');
    fs.rmSync(path.join(gone.work, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    const unread = loadPolicyAt(gone.work, gone.git('rev-parse', 'origin/main'), 'origin/main');
    expect(isUnavailable(unread)).toBe(true);
    const r = plan(gone);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('POLICY_SOURCE_UNAVAILABLE');

    const bad = census([':(icase)receipts/**']);
    const b = plan(bad);
    expect(b.status).toBe(EXIT.refused);
    expect(b.err).toContain('review_exclude_paths[0]');
    expect(b.err).toContain('(POLICY_INVALID)');
    expect(b.out).not.toContain('DISPATCH:');
  }, 120_000);
});

describe('the kept-file command is bounded by argument bytes', () => {
  // Value: protects=the DIFF_KEEP command stays under the Windows command line however many kept files a pattern has, and a
  //   disjoint small pattern still applies; fails_when=a pattern whose kept files pass KEEP_ARG_MAX_BYTES is applied, or the plan
  //   does not say why it was not; why_new=task 10; seam=bin/gstack-review-plan; no_claim=a real Windows launch
  test('a pattern whose kept files pass the bound is not applied and the plan says why; a disjoint small pattern applies', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['big/**', 'small/**']) } }); repos.push(repo);
    const long = 'x'.repeat(180);
    for (let k = 0; k < 140; k++) {
      write(repo.work, `big/${long}-${k}.sh`, '#!/bin/sh\n');
      fs.chmodSync(path.join(repo.work, `big/${long}-${k}.sh`), 0o755);
    }
    commit(repo, { 'big/data.json': '{}\n', 'small/data.json': '{}\n', 'lib/a.js': 'exports.a = 1;\n' });
    const text = plan(repo).out;
    expect(text).toMatch(new RegExp(`REVIEW_EXCLUDE: patterns=1/2 .* skipped=big/\\*\\*:kept=140:bytes=\\d+ \\(kept files over ${KEEP_ARG_MAX_BYTES} argument bytes: pattern not applied\\)`));
    const cmd = text.split('\n').find(l => l.startsWith('DIFF_CMD: '))!;
    expect(cmd).toContain("':(top,exclude,glob)small/**'");
    expect(cmd).not.toContain('big/**');
    expect(text).not.toContain('DIFF_KEEP:');
  }, 120_000);
});

describe('the review ceiling lines', () => {
  const d = { bytes: 3_500_000, byDir: [['results', 3_000_000], ['src', 500_000]] as Array<[string, number]> };
  // Value: protects=a REVIEW_DIFF_TOO_LARGE stop names the one fix that applies, with JSON a person can paste; fails_when=the
  //   fix ignores where the policy stands or prints a placeholder version; why_new=task 4; seam=tooLargeLine; no_claim=the bytes git reports
  test('the fix branches on no key, head-only, a skipped pattern and still over, with pasteable JSON at the key version', () => {
    const json = (line: string) => JSON.parse(line.match(/land (\{.*?\}) in /)![1]!);
    const none = tooLargeLine('ctx', 'batched', d, { state: 'none', base: 'main', source: 'origin/main@abc' }).line;
    expect(json(none)).toEqual({ review_exclude_paths: ['results/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION });
    expect(none).toContain('then bring main into this branch and rerun once; if it is still over, split the PR');
    const head = tooLargeLine('ctx', 'batched', d, { state: 'head-only', base: 'main', source: 'origin/main@abc', headPatterns: ['results/**'] }).line;
    expect(head).toContain('this branch declares review_exclude_paths, but only the copy on main applies');
    const skipped = tooLargeLine('ctx', 'batched', d, { state: 'active', base: 'main', source: 'origin/main@abc', record: { patterns: ['results/**'], skipped: [{ pattern: 'results/**', kept: 900, bytes: 40_000 }], excluded: 0 } }).line;
    expect(skipped).toContain('pattern results/** was not applied: its 900 kept files need 40000 argument bytes');
    const over = tooLargeLine('ctx', 'batched', d, { state: 'active', base: 'main', source: 'origin/main@abc', floor: '1.300.0.0', record: { patterns: ['receipts/**'], skipped: [], excluded: 12 } }).line;
    expect(over).toContain('still over after excluding 12 files');
    expect(json(over)).toEqual({ review_exclude_paths: ['receipts/**', 'results/**'], min_gstack_version: '1.300.0.0' });
    expect(over).toEndWith('nothing was written (REVIEW_DIFF_TOO_LARGE)');
  });

  // Value: protects=a REVIEW_DIFF_UNREADABLE stop says timeout or git exit, the timeout, and keeps full stderr in a file with
  //   remote URLs redacted; fails_when=a credential-bearing remote URL reaches the line or the log, or the fix ignores the
  //   reason; why_new=task 5; seam=readSelection and unreadableLine; no_claim=a real 120-second timeout
  test('a git exit and a timeout name their reason, the timeout and a redacted log file', () => {
    const repo = census();
    const r = readSelection(repo.work, 'f'.repeat(40), []);
    expect(r).toMatchObject({ ok: false, reason: 'git-exit', exit: 128 });
    if (r.ok) return;
    const logDir = path.join(repo.root, 'run');
    const line = unreadableLine('ctx', 'specialist/security', { ...r, stderr: `fatal: unable to access ${['https://bot', 'tok_fixture'].join(':')}${'@'}example.invalid/o/r.git/\nmore\n` }, 'f'.repeat(40), 'main', logDir);
    expect(line).toContain('reason=git-exit exit=128 timeout_ms=120000');
    expect(line).toContain('fix: git fetch origin main, then rerun once');
    expect(line).not.toContain('tok_fixture');
    const log = fs.readFileSync(path.join(logDir, 'diff-specialist_security.stderr'), 'utf8');
    expect(log).toContain('<url>');
    expect(log).not.toContain('tok_fixture');
    const slow = unreadableLine('ctx', 'batched', { ok: false, reason: 'timeout', exit: null, stderr: '', timeoutMs: 120_000 }, 'f'.repeat(40), 'main', logDir);
    expect(slow).toContain('reason=timeout exit=none timeout_ms=120000');
    expect(slow).toContain('rerun once unchanged; if it times out again, split the PR');
  }, 60_000);
});

describe('the receipt binds the selection the reviewers read', () => {
  const receiptIn = (body: string) => extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
  const writeReceipt = (repo: FixtureRepo, body: string, extra: string[]) =>
    runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body, ...extra]);
  const targetedAtHead = (repo: FixtureRepo) => ['--review-targeted', JSON.stringify({ classes: ['money', 'gate', 'auth', 'secret'], rules: 'r', brief_sha: 'a'.repeat(64), status: 'done', findings: 0, raised_by: 'targeted', head: repo.git('rev-parse', 'HEAD') })];
  // Value: protects=a docs-only range whose only file sits under a base pattern and carries a gate tag binds the same selection at
  //   plan and receipt write, so the receipt can be written; fails_when=receiptReviewAtHead skips the gate scan when the paths are
  //   docs-class and excludes the file the plan kept as gate-tagged (/ship review of #3852, red-team#1: digests 652d0aa8 vs
  //   6f33bd56, RECEIPT_INVALID with no fix); why_new=every other receipt case has a code path in its range; seam=gstack-review-plan
  //   --json and receiptReviewAtHead on one head; no_claim=the gate scan's own tag rules
  test('a docs-only range with a gate-tagged file under a pattern binds the plan\'s digest at receipt write', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-docs-', baseFiles: { '.gstack/ship-policy.json': policyText(['testdata/**']) } });
    repos.push(repo);
    const head = commit(repo, { 'testdata/expected.txt': 'expected output\n' });
    const planned = JSON.parse(runBin(repo, 'gstack-review-plan', ['--base', 'main', '--json']).out).review_exclude;
    expect(planned.kept_files).toEqual([{ path: 'testdata/expected.txt', reason: 'gate-tagged' }]);
    const prior = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = path.join(repo.root, 'receipt-state');
    let review: ReturnType<typeof receiptReviewAtHead>;
    try { review = receiptReviewAtHead(repo.work, 'main', path.join(import.meta.dir, '..', 'bin'), head); }
    finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
    const { exclude } = review;
    expect(exclude.state === 'active' ? exclude.record.digest : exclude.state).toBe(planned.digest);
  });
  // Value: protects=a receipt names the selection the rendered briefs read, a base merge that leaves the policy alone still
  //   carries, and a policy change on the base (adding or removing a pattern) needs a new review, not a write; fails_when=write
  //   records a digest the briefs never named, carry compares the base sha, or a removed exclusion clears by writing the old
  //   digest; why_new=tasks 2 and 7; seam=gstack-review-dispatch verify, gstack-ship-receipt write/carry, bindShippedReceipt;
  //   no_claim=the merge train's own refusal wording
  test('verify names the briefs\' digest; write binds it; a neutral base merge carries; a policy edit refuses write and carry', () => {
    const repo = census();
    const out = path.join(repo.root, 'pass');
    expect(runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', out, '--pass', 'p1', '--', '--gate-tagged', '0']).status).toBe(EXIT.ok);
    expect(runBin(repo, 'gstack-review-dispatch', ['stage', '--manifest', path.join(out, 'pass-manifest.json'), '--stage', 'voices']).status).toBe(EXIT.ok);
    const v = runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]);
    const digest = v.out.match(/^REVIEW_EXCLUDE_RECORD: digest=([0-9a-f]{64}) /m)?.[1];
    expect(digest).toBe(JSON.parse(plan(repo, ['--json']).out).review_exclude.digest);
    const body = path.join(repo.root, 'body.md');
    const missing = writeReceipt(repo, body, []);
    expect(missing.status).toBe(EXIT.fail);
    expect(missing.err).toContain(`field=review_exclude expected=${digest} recorded=none source=origin/main@`);
    expect(missing.err).toContain('gstack-review-dispatch verify --ledger <ledger>');
    expect(fs.existsSync(body)).toBe(false);
    expect(writeReceipt(repo, body, ['--review-exclude', digest!, ...targetedAtHead(repo)]).status).toBe(EXIT.ok);
    expect(receiptIn(body).review_exclude).toMatchObject({ digest, excluded: EXCLUDED.length, kept: KEPT.length });

    onBase(repo, { 'docs/other.md': '# other\n' });
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(carried.status).toBe(EXIT.ok);
    expect(receiptIn(body).review_exclude!.digest).toBe(digest!);

    onBase(repo, { '.gstack/ship-policy.json': policyText(['receipts/**', 'lib/**']) });
    const refused = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.err).toContain(`review_exclude changed: recorded=${digest}`);
    const head = repo.git('rev-parse', 'HEAD');
    const queue = bindShippedReceipt(repo.work, 'origin/main', fs.readFileSync(body, 'utf8').replace(/head: \S+/, `head: ${head}`), undefined, [head]);
    expect(queue.ok).toBe(false);

    onBase(repo, { '.gstack/ship-policy.json': JSON.stringify({}) + '\n' });
    const removed = writeReceipt(repo, path.join(repo.root, 'body2.md'), ['--review-exclude', digest!]);
    expect(removed.status).toBe(EXIT.fail);
    expect(removed.err).toContain(`field=review_exclude expected=none recorded=${digest}`);
  }, 240_000);

  // Value: protects=every place that describes write --review-exclude says what it checks: the digest HEAD has under the base
  //   policy, not that a review read that selection; fails_when=the help, troubleshooting, ship-policy or the queue's refusal
  //   line claims a receipt write alone cannot clear field=review_exclude while a write with the refusal's own expected= digest
  //   clears it with no review run; why_new=GST-972 item 2 (the #3852 cross-family trail review); seam=gstack-ship-receipt write
  //   and --help, excludeMismatch, the two docs; no_claim=binding the digest to the review ledger (write never reads it)
  test('write binds --review-exclude to the base policy, not to a review, and no description claims more', () => {
    const repo = census();
    const body = path.join(repo.root, 'body.md');
    const refused = writeReceipt(repo, body, []);
    const expected = refused.err.match(/field=review_exclude expected=([0-9a-f]{64}) /)?.[1];
    expect(expected).toBeDefined();
    expect(writeReceipt(repo, body, ['--review-exclude', expected!, ...targetedAtHead(repo)]).status).toBe(EXIT.ok);
    const doc = (rel: string) => fs.readFileSync(path.join(import.meta.dir, '..', rel), 'utf8').replace(/\s+/g, ' ');
    const claims = {
      help: runBin(repo, 'gstack-ship-receipt', ['--help']).out.replace(/\s+/g, ' '),
      troubleshooting: doc('docs/troubleshooting.md'),
      shipPolicy: doc('docs/ship-policy.md'),
      queue: excludeMismatch({ state: 'none' }, { review_exclude: { digest: expected } } as any, repo.git('rev-parse', 'HEAD'), 'origin/main')!,
    };
    for (const [where, text] of Object.entries(claims)) {
      expect({ where, overClaim: /write alone (cannot|does not) clear|never a receipt write alone/i.test(text) }).toEqual({ where, overClaim: false });
      expect({ where, says: text.includes('does not read the review ledger') }).toEqual({ where, says: true });
    }
  }, 240_000);

  // Value: protects=a base policy that gains review_exclude_paths does not void a receipt whose PR touches none of the new
  //   patterns, while a PR touching a pattern (an excluded or a kept file) and an unreadable base policy still refuse (a recorded
  //   digest that differs: GST-1434 below); fails_when=the queue compares recorded=none to the new digest without asking whether any changed
  //   file matches (GST-1408: harness-evals #264 stopped 9 receipted PRs), or the acceptance spreads to any of the four
  //   refusals; why_new=GST-1408; seam=bindShippedReceipt, which gstack-ship-queue ready, train build and land call, on receipts
  //   gstack-ship-receipt write produced; no_claim=carry (bin/gstack-ship-receipt carry keeps its own comparison)
  describe('a base policy that gains review_exclude_paths after the receipt (GST-1408)', () => {
    const policyOnBaseOnly = (repo: FixtureRepo, text: string) => {
      repo.git('checkout', '-q', 'main');
      commit(repo, { '.gstack/ship-policy.json': text }, 'base policy change');
      repo.git('push', '-q', 'origin', 'main');
      repo.git('checkout', '-q', 'feature');
      repo.git('fetch', '-q', 'origin');
    };
    const shipped = (files: Record<string, string>, basePolicy: string[] | null = null) => {
      const repo = makeFixtureRepo({ prefix: 'gstack-exclude-late-', baseFiles: basePolicy ? { '.gstack/ship-policy.json': policyText(basePolicy) } : {} });
      repos.push(repo);
      commit(repo, files);
      const body = path.join(repo.root, 'body.md');
      const extra = [...targetedAtHead(repo)];
      if (basePolicy) {
        const expected = writeReceipt(repo, body, extra).err.match(/field=review_exclude expected=([0-9a-f]{64}) /)?.[1];
        expect(expected).toBeDefined();
        extra.push('--review-exclude', expected!);
      }
      const w = writeReceipt(repo, body, extra);
      expect({ status: w.status, err: w.err }).toMatchObject({ status: EXIT.ok });
      return { repo, body };
    };
    const bind = (repo: FixtureRepo, body: string) => {
      const head = repo.git('rev-parse', 'HEAD');
      return bindShippedReceipt(repo.work, 'origin/main', fs.readFileSync(body, 'utf8'), undefined, [head]);
    };
    const CODE = { 'lib/reader.js': 'exports.p = 1;\n', 'docs/guide.md': '# guide\n' };

    test('a receipt with no digest binds when the PR touches none of the new patterns', () => {
      const { repo, body } = shipped(CODE);
      expect(receiptIn(body).review_exclude).toBeUndefined();
      policyOnBaseOnly(repo, policyText(['receipts/**', '**/*.jsonl']));
      const b = bind(repo, body);
      expect({ ok: b.ok, message: b.ok ? '' : b.message }).toEqual({ ok: true, message: '' });
    }, 240_000);

    test('a receipt with no digest still refuses when the PR touches a new pattern, excluded or kept', () => {
      const touches: Array<Record<string, string>> = [{ 'receipts/a/result.json': '{"ok": true}\n' }, { 'receipts/run.js': 'exports.run = 1;\n' }];
      for (const touched of touches) {
        const { repo, body } = shipped({ ...CODE, ...touched });
        policyOnBaseOnly(repo, policyText(['receipts/**']));
        const b = bind(repo, body);
        expect(b.ok).toBe(false);
        if (b.ok) continue;
        expect(b.code).toBe('RECEIPT_INVALID');
        expect(b.message).toMatch(/^field=review_exclude expected=[0-9a-f]{64} recorded=none /);
      }
    }, 240_000);

    // Value: protects=ready, train build and land bind a receipt whose recorded digest is older than the base policy's when
    //   neither the recorded selection nor HEAD's holds a PR file (carry's rule since #4030), while a selection that holds a PR
    //   file (excluded or kept, on either side) and an unreadable base policy still refuse; fails_when=the queue compares digests
    //   alone (GST-1434: harness-evals #274 and #276 refused after policy PR #278 merged, recorded=5ae7e95a07b5 expected=
    //   323c17cf6249), or the acceptance spreads to a selection that holds a PR file; why_new=GST-1434; seam=bindShippedReceipt,
    //   which gstack-ship-queue ready, train build and land call; no_claim=carry (GST-1415 below)
    test('the #274 shape: an older recorded digest binds after a policy edit on main when neither selection holds a PR file', () => {
      for (const after of [['receipts/**', 'results/**'], ['results/**']]) {
        const { repo, body } = shipped(CODE, ['receipts/**']);
        const recorded = receiptIn(body).review_exclude!.digest;
        expect(bind(repo, body).ok).toBe(true);
        policyOnBaseOnly(repo, policyText(after));
        const now = JSON.parse(plan(repo, ['--json']).out).review_exclude.digest;
        expect({ after, moved: typeof now === 'string' && now !== recorded }).toEqual({ after, moved: true });
        const b = bind(repo, body);
        expect({ after, ok: b.ok, message: b.ok ? '' : b.message }).toEqual({ after, ok: true, message: '' });
      }
    }, 240_000);

    test('a recorded digest that differs still refuses when the recorded and the current selection differ over the PR files', () => {
      const cases: Array<{ name: string; files: Record<string, string>; after: string[] }> = [
        { name: 'recorded excludes a PR file', files: { 'receipts/a/result.json': '{"ok": true}\n' }, after: ['results/**'] },
        { name: 'current excludes a PR file', files: { 'results/a.json': '{"ok": true}\n' }, after: ['receipts/**', 'results/**'] },
        { name: 'recorded keeps a PR file', files: { 'receipts/run.js': 'exports.run = 1;\n' }, after: ['results/**'] },
      ];
      for (const c of cases) {
        const { repo, body } = shipped({ ...CODE, ...c.files }, ['receipts/**']);
        const recorded = receiptIn(body).review_exclude!.digest;
        policyOnBaseOnly(repo, policyText(c.after));
        const b = bind(repo, body);
        expect({ name: c.name, ok: b.ok, code: b.ok ? '' : b.code }).toEqual({ name: c.name, ok: false, code: 'RECEIPT_INVALID' });
        if (!b.ok) expect(b.message).toMatch(new RegExp(`^field=review_exclude expected=[0-9a-f]{64} recorded=${recorded} `));
      }
    }, 240_000);

    test('an unreadable base policy still refuses a receipt with no digest or an older one', () => {
      for (const basePolicy of [null, ['receipts/**']]) {
        const { repo, body } = shipped(CODE, basePolicy);
        policyOnBaseOnly(repo, '{ "review_exclude_paths": "receipts/**" }\n');
        const b = bind(repo, body);
        expect({ basePolicy, ok: b.ok, code: b.ok ? '' : b.code }).toEqual({ basePolicy, ok: false, code: 'POLICY_INVALID' });
      }
    }, 240_000);
  });

  // Value: protects=a base policy change that selects no file the PR changed (a pattern gained, added beside another, removed or
  //   reverted) no longer voids the receipt at carry, and the queue binds the carried receipt, while a changed pattern that selects
  //   a PR file (excluded or kept) and an unreadable or malformed base policy still refuse; fails_when=carry compares the policy
  //   digest alone (GST-1415: harness-evals #263 re-ran a full five-reader review of an unchanged product), or the acceptance
  //   spreads to a selection that holds a PR file; why_new=GST-1415; seam=gstack-ship-receipt carry after a base merge, then
  //   bindShippedReceipt on the carried receipt; no_claim=the queue's own comparison of uncarried receipts (GST-1408 above)
  describe('carry after a base policy change (GST-1415)', () => {
    const CODE = { 'lib/reader.js': 'exports.p = 1;\n', 'docs/guide.md': '# guide\n' };
    const NO_KEY = JSON.stringify({}) + '\n';
    const shipped = (files: Record<string, string>, basePolicy: string[] | null) => {
      const repo = makeFixtureRepo({ prefix: 'gstack-exclude-carry-', baseFiles: basePolicy ? { '.gstack/ship-policy.json': policyText(basePolicy) } : {} });
      repos.push(repo);
      commit(repo, files);
      const body = path.join(repo.root, 'body.md');
      const extra = [...targetedAtHead(repo)];
      if (basePolicy) {
        const expected = writeReceipt(repo, body, extra).err.match(/field=review_exclude expected=([0-9a-f]{64}) /)?.[1];
        expect(expected).toBeDefined();
        extra.push('--review-exclude', expected!);
      }
      const w = writeReceipt(repo, body, extra);
      expect({ status: w.status, err: w.err }).toMatchObject({ status: EXIT.ok });
      return { repo, body, recorded: receiptIn(body).review_exclude?.digest ?? 'none' };
    };
    const carry = (repo: FixtureRepo, body: string) => runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);

    test('a pattern change that selects no PR file carries, and the queue binds the carried receipt', () => {
      const cases: Array<{ name: string; before: string[] | null; after: string }> = [
        { name: 'gained', before: null, after: policyText(['receipts/**']) },
        { name: 'added beside another', before: ['receipts/**'], after: policyText(['receipts/**', 'results/**']) },
        { name: 'removed beside another', before: ['receipts/**', 'results/**'], after: policyText(['receipts/**']) },
        { name: 'reverted', before: ['receipts/**'], after: NO_KEY },
      ];
      for (const c of cases) {
        const { repo, body, recorded } = shipped(CODE, c.before);
        onBase(repo, { '.gstack/ship-policy.json': c.after });
        const carried = carry(repo, body);
        expect({ name: c.name, status: carried.status, err: carried.status === EXIT.ok ? '' : carried.err }).toEqual({ name: c.name, status: EXIT.ok, err: '' });
        const head = repo.git('rev-parse', 'HEAD');
        const now = receiptIn(body);
        expect({ name: c.name, head: now.head, moved: (now.review_exclude?.digest ?? 'none') !== recorded }).toEqual({ name: c.name, head, moved: true });
        const b = bindShippedReceipt(repo.work, 'origin/main', fs.readFileSync(body, 'utf8'), undefined, [head]);
        expect({ name: c.name, ok: b.ok, message: b.ok ? '' : b.message }).toEqual({ name: c.name, ok: true, message: '' });
      }
    }, 240_000);

    test('a pattern change that selects a PR file, excluded or kept, still refuses carry', () => {
      const touches: Array<Record<string, string>> = [{ 'receipts/a/result.json': '{"ok": true}\n' }, { 'receipts/run.js': 'exports.run = 1;\n' }];
      const changes: Array<[string[] | null, string]> = [[null, policyText(['receipts/**'])], [['receipts/**'], NO_KEY]];
      for (const touched of touches) {
        for (const [before, after] of changes) {
          const { repo, body, recorded } = shipped({ ...CODE, ...touched }, before);
          onBase(repo, { '.gstack/ship-policy.json': after });
          const refused = carry(repo, body);
          expect({ touched: Object.keys(touched)[0], before, status: refused.status }).toEqual({ touched: Object.keys(touched)[0], before, status: EXIT.refused });
          expect(refused.err).toContain(`review_exclude changed: recorded=${recorded} `);
          expect(refused.err).toContain('(RECEIPT_CARRY_REFUSED;');
        }
      }
    }, 240_000);

    test('an unreadable or malformed base policy still refuses carry', () => {
      for (const text of [JSON.stringify({ review_exclude_paths: 'receipts/**', min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n', '{ not json\n']) {
        const { repo, body } = shipped(CODE, null);
        onBase(repo, { '.gstack/ship-policy.json': text });
        const refused = carry(repo, body);
        expect({ text, status: refused.status }).toEqual({ text, status: EXIT.refused });
        expect(refused.err).toContain('RECEIPT_CARRY_REFUSED');
        expect(refused.err).toContain('so its review_exclude_paths cannot be read');
      }
    }, 240_000);
  });

  // Value: protects=a base policy edit that gives the PR's files the same selection (the same applied patterns, excluded files
  //   and kept files with their reasons) no longer voids the reviewed digest at write, ready or carry, while a selection that
  //   differs over the PR files, a digest no policy the base held gives, an absent digest and an unreadable base policy still
  //   refuse; fails_when=a caller compares digests, or asks only whether both selections are empty (GST-1446: harness-evals #222
  //   at 558ad26d5, reviewed 7cf39a7e1150 under #272's three globs, which exclude 1,260 of its files, refused at write with
  //   expected dde43b124877 after #278 added six globs matching none of them); why_new=GST-1446; seam=gstack-ship-receipt write
  //   --review-exclude and carry, bindShippedReceipt (ready, train build, land); no_claim=the --docs-post exception (GST-1429 below)
  describe('a base policy edit that leaves the PR\'s selection alone (GST-1446)', () => {
    const BRANCH = { 'lib/reader.js': 'exports.p = 1;\n', 'receipts/a/result.json': '{"ok": true}\n', 'receipts/run.js': 'exports.run = 1;\n' };
    const policyOnBaseOnly = (repo: FixtureRepo, text: string) => {
      repo.git('checkout', '-q', 'main');
      commit(repo, { '.gstack/ship-policy.json': text }, 'base policy change');
      repo.git('push', '-q', 'origin', 'main');
      repo.git('checkout', '-q', 'feature');
      repo.git('fetch', '-q', 'origin');
    };
    const reviewed = () => {
      const repo = makeFixtureRepo({ prefix: 'gstack-exclude-same-', baseFiles: { '.gstack/ship-policy.json': policyText(['receipts/**']) } });
      repos.push(repo);
      commit(repo, BRANCH);
      const planned = JSON.parse(plan(repo, ['--json']).out).review_exclude;
      expect({ excluded: planned.excluded, kept: planned.kept_files }).toEqual({ excluded: 1, kept: [{ path: 'receipts/run.js', reason: 'code' }] });
      const body = path.join(repo.root, 'body.md');
      const w = writeReceipt(repo, body, ['--review-exclude', planned.digest, ...targetedAtHead(repo)]);
      expect({ status: w.status, err: w.err }).toMatchObject({ status: EXIT.ok });
      return { repo, body, digest: planned.digest as string };
    };
    const writeWith = (repo: FixtureRepo, extra: string[]) => writeReceipt(repo, path.join(repo.root, 'body-w.md'), [...extra, ...targetedAtHead(repo)]);
    const bind = (repo: FixtureRepo, body: string) => bindShippedReceipt(repo.work, 'origin/main', fs.readFileSync(body, 'utf8'), undefined, [repo.git('rev-parse', 'HEAD')]);
    const carry = (repo: FixtureRepo, body: string) => runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);

    test('the #222 shape: write, ready and carry bind the reviewed digest after main adds patterns that match no PR file', () => {
      const { repo, body, digest } = reviewed();
      policyOnBaseOnly(repo, policyText(['receipts/**', 'results/**', 'docs/benchmarks/*/results*/**/*.jsonl']));
      const now = JSON.parse(plan(repo, ['--json']).out).review_exclude.digest;
      expect(now).not.toBe(digest);
      const w = writeWith(repo, ['--review-exclude', digest]);
      expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
      expect(w.err).toContain(`REVIEW_EXCLUDE_POLICY_MOVED: reviewed=${digest.slice(0, 12)} head=${now.slice(0, 12)}`);
      expect(receiptIn(path.join(repo.root, 'body-w.md')).review_exclude!.digest).toBe(now);
      const b = bind(repo, body);
      expect({ ok: b.ok, message: b.ok ? '' : b.message }).toEqual({ ok: true, message: '' });
      repo.git('merge', '-q', '--no-edit', 'origin/main');
      const carried = carry(repo, body);
      expect({ status: carried.status, err: carried.status === EXIT.ok ? '' : carried.err }).toEqual({ status: EXIT.ok, err: '' });
      expect(receiptIn(body).review_exclude!.digest).toBe(now);
    }, 240_000);

    test('a policy edit that changes the selection over the PR files still refuses write, ready and carry', () => {
      const changes: Array<{ name: string; after: string[] }> = [
        { name: 'a new pattern keeps a PR file', after: ['receipts/**', 'lib/**'] },
        { name: 'the matching pattern is dropped', after: ['results/**'] },
        { name: 'the pattern narrows', after: ['receipts/a/**'] },
      ];
      for (const c of changes) {
        const { repo, body, digest } = reviewed();
        policyOnBaseOnly(repo, policyText(c.after));
        const w = writeWith(repo, ['--review-exclude', digest]);
        expect({ name: c.name, status: w.status }).toEqual({ name: c.name, status: EXIT.fail });
        expect(w.err).toContain(`field=review_exclude expected=`);
        expect(w.err).toContain(` recorded=${digest} `);
        const b = bind(repo, body);
        expect({ name: c.name, ok: b.ok, code: b.ok ? '' : b.code }).toEqual({ name: c.name, ok: false, code: 'RECEIPT_INVALID' });
        repo.git('merge', '-q', '--no-edit', 'origin/main');
        const refused = carry(repo, body);
        expect({ name: c.name, status: refused.status }).toEqual({ name: c.name, status: EXIT.refused });
        expect(refused.err).toContain(`review_exclude changed: recorded=${digest} `);
      }
    }, 240_000);

    test('an absent digest, a digest no base policy gives and an unreadable base policy still refuse write', () => {
      const { repo, digest } = reviewed();
      policyOnBaseOnly(repo, policyText(['receipts/**', 'results/**']));
      for (const extra of [[], ['--review-exclude', 'none'], ['--review-exclude', 'f'.repeat(64)]]) {
        const w = writeWith(repo, extra);
        expect({ extra, status: w.status }).toEqual({ extra, status: EXIT.fail });
        expect(w.err).toContain('field=review_exclude expected=');
      }
      policyOnBaseOnly(repo, '{ "review_exclude_paths": "receipts/**" }\n');
      const unreadable = writeWith(repo, ['--review-exclude', digest]);
      expect(unreadable.status).toBe(EXIT.refused);
      expect(unreadable.err).toContain('so its review_exclude_paths cannot be read');
    }, 240_000);

    test('two selections that keep the same PR file under different pattern lists bind at ready', () => {
      const repo = makeFixtureRepo({ prefix: 'gstack-exclude-same-kept-', baseFiles: { '.gstack/ship-policy.json': policyText(['receipts/**']) } });
      repos.push(repo);
      commit(repo, { 'lib/reader.js': 'exports.p = 1;\n', 'receipts/run.js': 'exports.run = 1;\n' });
      const digest = JSON.parse(plan(repo, ['--json']).out).review_exclude.digest;
      const body = path.join(repo.root, 'body.md');
      expect(writeReceipt(repo, body, ['--review-exclude', digest, ...targetedAtHead(repo)]).status).toBe(EXIT.ok);
      policyOnBaseOnly(repo, policyText(['receipts/**', 'results/**']));
      const b = bind(repo, body);
      expect({ ok: b.ok, message: b.ok ? '' : b.message }).toEqual({ ok: true, message: '' });
    }, 240_000);

    test('write rebuilds a reviewed policy that a later merge hides from default path history', () => {
      const { repo } = reviewed();
      policyOnBaseOnly(repo, policyText(['receipts/**', 'results/**']));
      const digest = JSON.parse(plan(repo, ['--json']).out).review_exclude.digest;
      repo.git('checkout', '-q', '-b', 'side', 'main~1');
      commit(repo, { 'notes/side.md': '# side\n' }, 'side work');
      repo.git('checkout', '-q', 'main');
      repo.git('merge', '-q', '--no-ff', '--no-commit', 'side');
      repo.git('checkout', 'side', '--', '.gstack/ship-policy.json');
      repo.git('commit', '-q', '-m', 'merge side, restoring the earlier policy');
      repo.git('push', '-q', 'origin', 'main');
      repo.git('checkout', '-q', 'feature');
      repo.git('fetch', '-q', 'origin');
      expect(repo.git('log', '--format=%s', 'origin/main', '--', '.gstack/ship-policy.json')).not.toContain('base policy change');
      const w = writeWith(repo, ['--review-exclude', digest]);
      expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
      expect(w.err).toContain(`REVIEW_EXCLUDE_POLICY_MOVED: reviewed=${digest.slice(0, 12)} `);
    }, 240_000);
  });

  // Value: protects=a receipt write after /ship's Step 14.5 docs audit binds the digest the reviewers read when the only change to
  //   the selection since the review is files under review_exclude_paths that the audit's post snapshot names (GST-1429: gbrain
  //   #8627's audit added a key-files entry, a docs file code names, and write refused with RECEIPT_INVALID field=review_exclude,
  //   forcing a third review pass), a docs edit the review read uncommitted stays when --docs-pre names the Prepare snapshot and
  //   checkout line endings compare as committed (the #4034 review), while a selection change from anything else, an audit file the exclusion reads as code, an
  //   edit after the snapshot and a missing snapshot still refuse; fails_when=write accepts a changed selection without the
  //   snapshot, or the exception spreads to files the snapshot does not name or the exclusion does not hide or keep as docs;
  //   why_new=GST-1429; seam=gstack-docs-candidate snapshot, then gstack-ship-receipt write --review-exclude --docs-post;
  //   no_claim=what the docs audit itself may edit (ship/sections/documentation.md)
  describe('a docs audit after the review (GST-1429)', () => {
    const BRANCH = { 'lib/reader.js': "exports.p = 'docs/parity.md';\n", 'docs/parity.md': '# parity\n', 'docs/old.md': '# old\n' };
    /** A branch reviewed at its head with `dirty` uncommitted (the plan's digest is what verify prints), then audited: the Prepare snapshot is saved, `audit` edits the tree, the post snapshot is saved, `after` edits more, and everything is committed. */
    const audited = (audit: Record<string, string | null>, after: Record<string, string | null> = {}, branch: Record<string, string> = BRANCH, opts: { dirty?: Record<string, string>; autocrlf?: boolean } = {}) => {
      const repo = makeFixtureRepo({ prefix: 'gstack-exclude-audit-', baseFiles: { '.gstack/ship-policy.json': policyText(['docs/**', 'test/fixtures/goldens/**']), 'docs/key-files.md': '# key files\n', 'lib/index.js': "exports.k = 'docs/key-files.md';\n" } });
      repos.push(repo);
      commit(repo, branch);
      if (opts.autocrlf) repo.git('config', 'core.autocrlf', 'true');
      for (const [rel, text] of Object.entries(opts.dirty ?? {})) write(repo.work, rel, text);
      const reviewed = JSON.parse(plan(repo, ['--json']).out).review_exclude.digest as string;
      const snapshot = (out: string) => {
        const snap = runBin(repo, 'gstack-docs-candidate', ['snapshot', '--out', out, '--audit-id', 'a1', '--mode', 'edit', '--base', repo.git('rev-parse', 'origin/main'), '--docs', 'docs']);
        expect({ status: snap.status, err: snap.err }).toMatchObject({ status: 0 });
      };
      const pre = path.join(repo.root, 'a1.json');
      snapshot(pre);
      for (const [rel, text] of Object.entries(audit)) { if (text === null) fs.rmSync(path.join(repo.work, rel), { force: true }); else write(repo.work, rel, text); }
      const post = path.join(repo.root, 'a1-post.json');
      snapshot(post);
      commit(repo, after, 'docs audit and release');
      return { repo, reviewed, pre, post, body: path.join(repo.root, 'body.md') };
    };
    const writeWith = (a: ReturnType<typeof audited>, post: string | null = a.post, pre: string | null = null) =>
      writeReceipt(a.repo, a.body, ['--review-exclude', a.reviewed, ...(post === null ? [] : ['--docs-post', post]), ...(pre === null ? [] : ['--docs-pre', pre]), ...targetedAtHead(a.repo)]);
    const refusedWith = (w: { status: number | null; err: string }, a: ReturnType<typeof audited>, why: string) => {
      expect({ status: w.status, written: fs.existsSync(a.body) }).toEqual({ status: EXIT.fail, written: false });
      expect(w.err).toContain(`field=review_exclude expected=`);
      expect(w.err).toContain(`recorded=${a.reviewed} `);
      expect(w.err).toContain(why);
    };

    test('the #8627 shape: an audit edit to a docs file code names binds the reviewed digest with the post snapshot only', () => {
      const a = audited({ 'docs/key-files.md': '# key files\n- lib/reader.js: the parity guard\n' }, {}, { 'lib/reader.js': BRANCH['lib/reader.js'], 'docs/parity.md': BRANCH['docs/parity.md'] });
      const prior = process.env.GSTACK_STATE_ROOT;
      process.env.GSTACK_STATE_ROOT = path.join(a.repo.root, 'receipt-state');
      let head: ReturnType<typeof receiptReviewAtHead>['exclude'];
      try { head = receiptReviewAtHead(a.repo.work, 'main', path.join(import.meta.dir, '..', 'bin'), a.repo.git('rev-parse', 'HEAD')).exclude; }
      finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
      expect(head.state === 'active' ? head.kept.map(k => [k.path, k.reason]) : head.state).toEqual([['docs/key-files.md', 'named-by-code'], ['docs/parity.md', 'named-by-code']]);
      expect(head.state === 'active' && head.record.digest).not.toBe(a.reviewed);
      refusedWith(writeWith(a, null), a, '(write compares the argument, not the review ledger)');
      const w = writeWith(a);
      expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
      expect(w.err + w.out).toContain(`REVIEW_EXCLUDE_DOCS_AUDIT: reviewed=${a.reviewed.slice(0, 12)} `);
      expect(receiptIn(a.body).review_exclude!.digest).toBe(head.state === 'active' ? head.record.digest : 'none');
    }, 240_000);

    test('an audit that adds an excluded docs file and removes one the branch added binds', () => {
      const a = audited({ 'docs/new.md': '# new\n', 'docs/old.md': null });
      const w = writeWith(a);
      expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
      expect(w.err + w.out).toContain('files=docs/new.md,docs/old.md');
    }, 240_000);

    test('a selection change outside the audit, or an audit file the exclusion reads as code, still refuses', () => {
      const code = audited({ 'docs/new.md': '# new\n' }, { 'lib/old.js': "exports.o = 'docs/old.md';\n" });
      refusedWith(writeWith(code), code, 'is not the selection HEAD has with the files under review_exclude_paths that changed since the snapshot reset');
      const outside = audited({ 'docs/new.md': '# new\n', 'lib/reader.js': "exports.p = 'docs/parity.md';\nexports.o = 'docs/old.md';\n" });
      refusedWith(writeWith(outside), outside, 'is not the selection HEAD has with the files under review_exclude_paths that changed since the snapshot reset');
      const tool = audited({ 'docs/tool.js': 'exports.t = 1;\n' });
      refusedWith(writeWith(tool), tool, 'docs/tool.js is code at HEAD');
    }, 240_000);

    test('an edit after the snapshot, a file the snapshot does not name and a missing snapshot still refuse', () => {
      const late = audited({ 'docs/new.md': '# new\n' }, { 'docs/new.md': '# new, edited after the snapshot\n' });
      refusedWith(writeWith(late), late, 'docs/new.md at HEAD is not the content the snapshot recorded');
      const unnamed = audited({}, { 'docs/new.md': '# new\n' });
      refusedWith(writeWith(unnamed), unnamed, 'docs/new.md changed after the snapshot');
      refusedWith(writeWith(unnamed, path.join(unnamed.repo.root, 'missing-post.json')), unnamed, 'missing-post.json: cannot be read');
    }, 240_000);

    test('a docs edit the review read uncommitted stays with the Prepare snapshot, and checkout line endings compare as committed', () => {
      const dirty = audited({ 'docs/new.md': '# new\n' }, {}, BRANCH, { dirty: { 'docs/key-files.md': '# key files\n- lib/reader.js: the parity guard\n' } });
      refusedWith(writeWith(dirty), dirty, 'is not the selection HEAD has with the files under review_exclude_paths that changed since the snapshot reset');
      const kept = writeWith(dirty, dirty.post, dirty.pre);
      expect({ status: kept.status, err: kept.status === EXIT.ok ? '' : kept.err }).toEqual({ status: EXIT.ok, err: '' });
      expect(kept.err + kept.out).toContain('files=docs/new.md ');
      const crlf = audited({ 'docs/new.md': '# new\r\n' }, {}, BRANCH, { autocrlf: true });
      const w = writeWith(crlf, crlf.post, crlf.pre);
      expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
    }, 240_000);
  });

  // Value: protects=one /ship run whose Step 14.5 ran twice (an audit, then a base merge and restamp, then the re-audit) binds the
  //   digest the reviewers read when every change to the selection since the review is a file one of the run's audits edited
  //   (GST-1616: gbrain #8678 refused RECEIPT_INVALID field=review_exclude because the first audit's committed file stayed in the
  //   selection, and the only way out was HEAD's digest, which skips review of the delta), while a non-audit edit to an excluded
  //   file and another run's audit list still refuse; fails_when=write resets only the latest audit's files, takes a carried list
  //   from another run, resets an earlier audit's file that something else edited later, or drops that audit on a retry so an
  //   unreviewed edit to a file code names binds (the #4071 outside voice); why_new=GST-1616;
  //   seam=gstack-docs-candidate snapshot --run --pre --carry, then gstack-ship-receipt write --review-exclude --docs-post --docs-pre;
  //   no_claim=how many audits one run may launch (ship/sections/documentation.md)
  describe('two docs audits in one /ship run (GST-1616)', () => {
    const RUN = '/records/ship-8678.md';
    const BRANCH = { 'lib/reader.js': "exports.p = 'docs/parity.md';\n", 'docs/parity.md': '# parity\n' };
    /** The #8678 shape: reviewed; audit a1 edits docs/guide.md (excluded, untouched by the branch) and is committed; main moves and is merged; the release is restamped with `between`; audit a3 adds docs/new.md, its post snapshot carries a1's unless `carry` is false, and it is committed. `a1`/`a3` replace the audits' edits (null deletes) and `rereview` re-takes the reviewed digest after the restamp. */
    const twoAudits = (opts: { between?: Record<string, string | null>; carry?: boolean; a1?: Record<string, string | null>; a3?: Record<string, string | null>; rereview?: boolean } = {}) => {
      const repo = makeFixtureRepo({ prefix: 'gstack-exclude-audits-', baseFiles: { '.gstack/ship-policy.json': policyText(['docs/**', 'test/fixtures/goldens/**']), 'docs/guide.md': '# guide\n', 'lib/index.js': "exports.k = 'docs/key-files.md';\n" } });
      repos.push(repo);
      commit(repo, BRANCH);
      const digest = () => JSON.parse(plan(repo, ['--json']).out).review_exclude.digest as string;
      let reviewed = digest();
      const apply = (files: Record<string, string | null>) => { for (const [p, c] of Object.entries(files)) if (c === null) fs.rmSync(path.join(repo.work, p)); else write(repo.work, p, c); };
      const snapshot = (id: string, out: string, extra: string[] = [], run = RUN) => {
        const file = path.join(repo.root, out);
        return { file, ...runBin(repo, 'gstack-docs-candidate', ['snapshot', '--out', file, '--audit-id', id, '--mode', 'edit', '--base', repo.git('rev-parse', 'origin/main'), '--docs', 'docs', '--run', run, ...extra]) };
      };
      const saved = (s: ReturnType<typeof snapshot>) => { expect({ status: s.status, err: s.err }).toMatchObject({ status: 0 }); return s.file; };
      const pre1 = saved(snapshot('a1', 'a1.json'));
      apply(opts.a1 ?? { 'docs/guide.md': '# guide\n\nUpdated by the docs audit.\n' });
      const post1 = saved(snapshot('a1', 'a1-post.json', ['--pre', pre1]));
      commit(repo, {}, 'docs audit a1');
      onBase(repo, { 'notes/base.md': '# base\n' });
      commit(repo, { VERSION: '1.0.1\n', ...opts.between }, 'restamp');
      if (opts.rereview) reviewed = digest();
      const pre = saved(snapshot('a3', 'a3.json'));
      apply(opts.a3 ?? { 'docs/new.md': '# new\n' });
      const post = saved(snapshot('a3', 'a3-post.json', ['--pre', pre, ...(opts.carry === false ? [] : ['--carry', post1])]));
      commit(repo, {}, 'docs audit a3');
      return { repo, reviewed, pre, post, post1, snapshot, body: path.join(repo.root, 'body.md') };
    };
    const writeWith = (a: ReturnType<typeof twoAudits>, post = a.post) =>
      writeReceipt(a.repo, a.body, ['--review-exclude', a.reviewed, '--docs-post', post, '--docs-pre', a.pre, ...targetedAtHead(a.repo)]);
    const refusedWith = (w: { status: number | null; err: string }, a: ReturnType<typeof twoAudits>, why: string) => {
      expect({ status: w.status, written: fs.existsSync(a.body) }).toEqual({ status: EXIT.fail, written: false });
      expect(w.err).toContain(`recorded=${a.reviewed} `);
      expect(w.err).toContain(why);
    };

    test('the #8678 shape: a re-audit after a base merge and restamp binds the reviewed digest with both audits\' files reset', () => {
      const lone = twoAudits({ carry: false });
      refusedWith(writeWith(lone), lone, 'is not the selection HEAD has with the files under review_exclude_paths');
      const a = twoAudits();
      const w = writeWith(a);
      expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
      expect(w.err + w.out).toContain(`REVIEW_EXCLUDE_DOCS_AUDIT: reviewed=${a.reviewed.slice(0, 12)} `);
      expect(w.err + w.out).toContain('files=docs/guide.md,docs/new.md ');
      expect(receiptIn(a.body).review_exclude!.digest).not.toBe(a.reviewed);
    }, 240_000);

    test('a file no audit edited, or an edit after an audit to the file it edited, still refuses', () => {
      const stray = twoAudits({ between: { 'docs/stray.md': '# stray\n' } });
      refusedWith(writeWith(stray), stray, 'is not the selection HEAD has with the files under review_exclude_paths');
      const later = twoAudits({ between: { 'docs/guide.md': '# guide\n\nEdited after the docs audit.\n' } });
      refusedWith(writeWith(later), later, 'docs/guide.md at HEAD is not the content audit a1 recorded');
      const kept = twoAudits({ a1: { 'docs/parity.md': '# parity\naudited\n' }, between: { 'docs/parity.md': '# parity\nan unreviewed edit\n' } });
      refusedWith(writeWith(kept), kept, 'docs/parity.md at HEAD is not the content audit a1 recorded');
    }, 360_000);

    test('another run\'s audit list is refused, at the snapshot and at write', () => {
      const a = twoAudits();
      const otherPre = a.snapshot('a3', 'a3-other-pre.json', [], '/records/another-run.md');
      expect({ status: otherPre.status, err: otherPre.err }).toMatchObject({ status: 0 });
      const other = a.snapshot('a3', 'a3-other.json', ['--pre', otherPre.file, '--carry', a.post1], '/records/another-run.md');
      expect({ status: other.status, written: fs.existsSync(other.file) }).toEqual({ status: 1, written: false });
      expect(other.err).toContain('another /ship run');
      const forged = path.join(a.repo.root, 'a3-forged.json');
      const post = JSON.parse(fs.readFileSync(a.post, 'utf8'));
      post.earlier[0].run_id = '/records/another-run.md';
      fs.writeFileSync(forged, JSON.stringify(post));
      refusedWith(writeWith(a, forged), a, 'audit a1 of another /ship run');
    }, 240_000);

    // Value: protects=write refuses a carried list it cannot trust: no --docs-pre, a --docs-pre of another run, a malformed, duplicated
    //   or run-less earlier, a carried HEAD off the snapshot's history, or a file changed between two audits outside both;
    //   fails_when=a guard in writeExcludeBinds or carriedAudits is dropped and write binds the reviewed digest anyway;
    //   why_new=only the success path, stray/later edits and another run's entry were covered; seam=none; no_claim=snapshot-side refusals
    test('write refuses a carried audit list it cannot trust', () => {
      const a = twoAudits();
      refusedWith(writeReceipt(a.repo, a.body, ['--review-exclude', a.reviewed, '--docs-post', a.post, ...targetedAtHead(a.repo)]), a, 'carries audit a1, so write needs --docs-pre');
      const forge = (name: string, edit: (j: any) => void) => { const j = JSON.parse(fs.readFileSync(name === 'pre' ? a.pre : a.post, 'utf8')); edit(j); const f = path.join(a.repo.root, `forged-${name}-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(j)); return f; };
      const otherPre = forge('pre', j => { j.run_id = '/records/another-run.md'; });
      refusedWith(writeReceipt(a.repo, a.body, ['--review-exclude', a.reviewed, '--docs-post', a.post, '--docs-pre', otherPre, ...targetedAtHead(a.repo)]), a, 'its HEAD, audit_id or run_id differs');
      const orphan = a.repo.git('commit-tree', '-m', 'orphan', a.repo.git('hash-object', '-t', 'tree', '-w', '/dev/null'));
      const rows: Array<[(j: any) => void, string]> = [
        [j => { j.earlier = j.earlier[0]; }, 'its earlier field is not a list of audits'],
        [j => { j.earlier[0].edited = []; }, 'is not { run_id, audit_id, head, edited }'],
        [j => { j.earlier.push(j.earlier[0]); }, 'carries audit a1 twice'],
        [j => { j.earlier[0].head = orphan; }, `carried audit a1's HEAD ${orphan.slice(0, 12)} is not an ancestor`],
        [j => { j.earlier.push({ ...j.earlier[0], audit_id: 'a2', edited: { 'docs/guide.md': { before: null, after: null } } }); }, 'docs/guide.md changed between audit a1 and audit a2, outside both'],
      ];
      for (const [edit, why] of rows) refusedWith(writeWith(a, forge('post', edit)), a, why);
      const runless = (j: any) => { delete j.run_id; };
      refusedWith(writeReceipt(a.repo, a.body, ['--review-exclude', a.reviewed, '--docs-post', forge('post', runless), '--docs-pre', forge('pre', runless), ...targetedAtHead(a.repo)]), a, 'names no run_id');
    }, 240_000);

    // Value: protects=write binds an honest re-audit that undid, or re-edited, the carried audit's file, and one whose review ran
    //   after the carried audit; fails_when=the moved skip drops a file the re-audit reverted, the reset target or the Prepare-side
    //   check for a twice-edited file regresses, or write insists on the carried audit when the review already read it;
    //   why_new=the other GST-1616 rows edit disjoint files and review before both audits; seam=none; no_claim=a live /ship run
    test('write binds a re-audit that reverts or re-edits the carried audit\'s file, and a review between the two audits', () => {
      const binds = (a: ReturnType<typeof twoAudits>, files: string, audits: string) => {
        const w = writeWith(a);
        expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
        expect(w.err + w.out).toContain(`files=${files}${audits} (`);
      };
      binds(twoAudits({ a1: { 'docs/x.md': '# x\n' }, a3: { 'docs/x.md': null, 'docs/new.md': '# new\n' } }), 'docs/new.md,docs/x.md', ' audits=a1,a3');
      binds(twoAudits({ a1: { 'docs/guide.md': null }, a3: { 'docs/guide.md': '# guide\n', 'docs/new.md': '# new\n' } }), 'docs/guide.md,docs/new.md', ' audits=a1,a3');
      const again = twoAudits({ a3: { 'docs/guide.md': '# guide\n\nEdited again by the re-audit.\n', 'docs/new.md': '# new\n' } });
      binds(again, 'docs/guide.md,docs/new.md', ' audits=a1,a3');
      const between = path.join(again.repo.root, 'between.md');
      fs.writeFileSync(between, '# guide\n\nEdited between the audits.\n');
      const pre = JSON.parse(fs.readFileSync(again.pre, 'utf8'));
      pre.hashes['docs/guide.md'] = again.repo.git('hash-object', '-w', between);
      fs.writeFileSync(again.pre, JSON.stringify(pre));
      fs.rmSync(again.body, { force: true });
      refusedWith(writeWith(again), again, "docs/guide.md at this audit's Prepare snapshot is not the content audit a1 recorded");
      binds(twoAudits({ a1: { 'docs/x.md': '# x\n' }, rereview: true }), 'docs/new.md', '');
    }, 480_000);
  });
});

describe('a branch cannot hide code under a base pattern', () => {
  // Value: protects=a branch cannot hide code or a link under a base-declared pattern, and untracked files never move the
  //   selection away from the committed head the receipt reads; fails_when=the branch's .gitattributes makes a code file
  //   binary content, a NUL-bearing code file is excluded as binary, a symlink is excluded as data, or an untracked file under a pattern changes the plan's digest;
  //   why_new=/ship pass-1 security and Red Team findings on GST-508, each reproduced before the fix; seam=bin/gstack-review-plan;
  //   no_claim=gitlinks (the same mode rule, no fixture)
  test('a branch .gitattributes cannot make code binary, a symlink is kept, and an untracked file leaves the digest alone', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['receipts/**']) } }); repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'receipts/real.gz'), GZ);
    fs.symlinkSync('../.env', path.join(repo.work, 'receipts/config.json'));
    commit(repo, { '.gitattributes': 'receipts/** binary\n', 'receipts/evil.ts': 'export const run = () => 1;\n', 'receipts/a.json': '{}\n' });
    const p = JSON.parse(plan(repo, ['--json']).out);
    expect(p.review_exclude.kept_files).toEqual([
      { path: 'receipts/config.json', reason: 'link' },
      { path: 'receipts/evil.ts', reason: 'code' },
    ]);
    expect(p.review_exclude.content).toMatchObject({ binary: 1, data: 1 });
    write(repo.work, 'receipts/stray/result.json', '{"ok": true}\n');
    expect(JSON.parse(plan(repo, ['--json']).out).review_exclude.digest).toBe(p.review_exclude.digest);
  }, 120_000);
  test('a binary file at a code path stays kept and still forces full depth; a .gz stays binary content', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['assets/**']) } }); repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'assets/loader.js'), '/* \0 */ require("child_process").exec("id");\n');
    fs.writeFileSync(path.join(repo.work, 'assets/real.gz'), GZ);
    commit(repo, {});
    const p = JSON.parse(plan(repo, ['--json']).out);
    expect(p.review_exclude.kept_files).toEqual([{ path: 'assets/loader.js', reason: 'code' }]);
    expect(p.review_exclude.content).toMatchObject({ binary: 1 });
    expect(p).toMatchObject({ depth: 'full', errors: expect.arrayContaining([expect.objectContaining({ code: 'binary_code_path', input: 'assets/loader.js' })]) });
  }, 120_000);

  // Value: protects=a compiled binary under a base pattern stays in review, because it is code; fails_when=a .node, .so, .so.N,
  //   .dylib or .dll file, or an ELF, Mach-O or PE image under a content extension (.bin, .dat), is excluded as binary content;
  //   why_new=GST-972 item 3; seam=bin/gstack-review-plan; no_claim=what a reader can see inside a binary
  test('native binaries are code: .node, .so, .dylib, .dll and executable images under a content extension stay kept', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['assets/**']) } }); repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'assets'), { recursive: true });
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(24)]);
    const macho = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(28)]);
    const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30)]);
    const files = { 'assets/addon.node': elf, 'assets/libx.dylib': macho, 'assets/libx.so': elf, 'assets/libx.so.1': elf, 'assets/setup.dat': pe, 'assets/tool.bin': elf, 'assets/x.dll': pe, 'assets/real.gz': GZ };
    for (const [rel, bytes] of Object.entries(files)) fs.writeFileSync(path.join(repo.work, rel), bytes);
    commit(repo, {});
    const p = JSON.parse(plan(repo, ['--json']).out);
    expect(p.review_exclude.kept_files).toEqual(Object.keys(files).filter(f => f !== 'assets/real.gz').map(f => ({ path: f, reason: 'code' })));
    expect(p.review_exclude).toMatchObject({ excluded: 1, content: { binary: 1 } });
  }, 120_000);

  // Value: protects=a branch's .gitattributes cannot get an executable image excluded by making git read it as text, and a
  //   64-bit universal Mach-O is an executable image; fails_when=only files git reports as binary under the branch's own
  //   attributes get the magic check, so an ELF named .png under '*.png diff -binary' is excluded as data, or 0xcafebabf
  //   is not executable magic; why_new=GST-972 item 3 follow-up (#3910, #3902 outside voice); seam=bin/gstack-review-plan and
  //   reviewExclude in head mode; no_claim=a NUL-free script under a content extension
  test('a branch .gitattributes that makes git read an ELF as text cannot get it excluded; fat64 Mach-O is native', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['assets/**']) } }); repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'assets/native.png'), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(24)]));
    fs.writeFileSync(path.join(repo.work, 'assets/fat64.dat'), Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbf]), Buffer.alloc(28)]));
    fs.writeFileSync(path.join(repo.work, 'assets/real.gz'), GZ);
    commit(repo, { '.gitattributes': '*.png diff -binary\n' });
    const p = JSON.parse(plan(repo, ['--json']).out);
    const kept = [{ path: 'assets/fat64.dat', reason: 'code' as const }, { path: 'assets/native.png', reason: 'code' as const }];
    expect(p.review_exclude.kept_files).toEqual(kept);
    expect(p.review_exclude).toMatchObject({ excluded: 1, content: { binary: 1 } });
    const head = repo.git('rev-parse', 'HEAD');
    const baseSha = repo.git('rev-parse', 'origin/main');
    const c = collectCommit(repo.work, baseSha, head);
    const x = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged: new Set(), context: 'test' });
    expect(x.state === 'active' && x.kept).toEqual(kept);
    expect(x.state === 'active' && x.record.digest).toBe(p.review_exclude.digest);
  }, 120_000);

  // Value: protects=a NUL byte cannot turn code or a key file into excludable content; fails_when=a NUL-bearing file with a
  //   source extension outside the old CODE_EXT list (.gradle, .sql, .tf, .groovy), a key store (.p12) or an extensionless key
  //   is excluded as binary; why_new=GST-972 item 6 (#3852 targeted gate reader at 61803d9); seam=bin/gstack-review-plan;
  //   no_claim=the list of binary content extensions is complete (an unknown one is kept, never excluded)
  test('a NUL-bearing file is binary content only under a known content extension; code and key files stay kept', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['assets/**']) } }); repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'assets'), { recursive: true });
    const nul = (code: string) => Buffer.from(`/* \0 */ ${code}\n`);
    const kept = { 'assets/Build.groovy': nul('println "x"'), 'assets/build.gradle': nul('apply plugin: "java"'), 'assets/id_ed25519': nul('openssh-key-v1'), 'assets/main.tf': nul('resource "x" "y" {}'), 'assets/query.sql': nul('DROP TABLE users;'), 'assets/server.p12': Buffer.from([0x30, 0x82, 0, 1, 2, 3]) };
    const content = { 'assets/report.pdf': GZ, 'assets/shot.png': GZ };
    for (const [rel, bytes] of Object.entries({ ...kept, ...content })) fs.writeFileSync(path.join(repo.work, rel), bytes);
    commit(repo, {});
    const p = JSON.parse(plan(repo, ['--json']).out);
    expect(p.review_exclude.kept_files).toEqual(Object.keys(kept).map(f => ({ path: f, reason: /id_ed25519|\.p12$/.test(f) ? 'gate-path' : 'code' })));
    expect(p.review_exclude).toMatchObject({ excluded: 2, content: { binary: 2 } });
  }, 120_000);

  // Value: protects=a binary token store under an excluded glob stays in every reader's diff (GST-1350 narrowed the token name
  //   rule to source and style files); fails_when=a token-named binary with no text lines is excluded as content; seam=bin/gstack-review-plan
  test('a binary token store under an excluded glob is kept as a gate path', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['assets/**']) } }); repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'assets'), { recursive: true });
    for (const rel of ['assets/tokens.db', 'assets/shot.png']) fs.writeFileSync(path.join(repo.work, rel), GZ);
    commit(repo, {});
    const p = JSON.parse(plan(repo, ['--json']).out);
    expect(p.review_exclude.kept_files).toEqual([{ path: 'assets/tokens.db', reason: 'gate-path' }]);
    expect(p.review_exclude).toMatchObject({ excluded: 1, content: { binary: 1 } });
  }, 120_000);

  // Value: protects=a branch's .gitattributes cannot get a matched file with a credential line excluded by making git call it
  //   binary, at the plan (live tree) and at the receipt (head blobs); fails_when=the secret-line rule reads only the
  //   collector's added lines, which git leaves empty for an attribute-binary file, so the file is excluded; why_new=GST-972
  //   item 5 (#3852 round 3, outside-voice#2); seam=bin/gstack-review-plan and reviewExclude in head mode; no_claim=pregate's gitleaks scan, what readers' own diffs show (they still follow the attributes)
  test('a branch .gitattributes marking receipts binary cannot get a credential-line file excluded: the keep rule reads the text', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-exclude-', baseFiles: { '.gstack/ship-policy.json': policyText(['receipts/**']) } }); repos.push(repo);
    const secret = '{"cmd": "curl -H $OPENAI_API_KEY"}\n';
    commit(repo, { '.gitattributes': 'receipts/** binary\n', 'receipts/s.json': secret, 'receipts/a.b/c.json': secret, 'receipts/a.json': '{"ok": true}\n', 'receipts/a/t.json': '{"ok": true}\n' });
    const p = JSON.parse(plan(repo, ['--json']).out);
    const kept = [{ path: 'receipts/a.b/c.json', reason: 'secret-line' as const }, { path: 'receipts/s.json', reason: 'secret-line' as const }];
    expect(p.review_exclude.kept_files).toEqual(kept);
    expect(p.review_exclude).toMatchObject({ excluded: 2, content: { data: 2 } });
    const head = repo.git('rev-parse', 'HEAD');
    const baseSha = repo.git('rev-parse', 'origin/main');
    const c = collectCommit(repo.work, baseSha, head);
    const x = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged: new Set(), context: 'test' });
    expect(x.state === 'active' && x.kept).toEqual(kept);
    expect(x.state === 'active' && x.record.digest).toBe(p.review_exclude.digest);
  }, 120_000);

  test('an unavailable gate scan keeps every candidate instead of excluding it', () => {
    const repo = census();
    const head = repo.git('rev-parse', 'HEAD');
    const baseSha = repo.git('rev-parse', 'origin/main');
    const c = collectCommit(repo.work, baseSha, head);
    const at = (gateTagged: ReadonlySet<string> | null) => reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged, context: 'test' });
    const scanned = at(new Set());
    expect(scanned.state === 'active' && [...scanned.excluded].sort()).toEqual([...EXCLUDED].sort());
    const blind = at(null);
    expect(blind.state).toBe('active');
    if (blind.state !== 'active') return;
    expect(blind.excluded.size).toBe(0);
    expect(blind.kept.filter(k => k.reason === 'gate-scan-unavailable').map(k => k.path).sort()).toEqual([...EXCLUDED, 'receipts/b/result.json', 'receipts/d/fixture.json'].sort());
  }, 120_000);

  // Value: protects=the named-by-code scan reads only the code and test files that can name a candidate, so its cost follows
  //   the consumers and not the data a results PR adds; fails_when=git grep reads the whole tree, so 4,354 receipts and 30 MB of
  //   data under the patterns are searched for every candidate path (GST-1435: harness-evals #269 ran 278 s past the 120 s limit
  //   and kept every file as consumer-scan-unavailable), or the scoped scan stops finding a full-path reference; why_new=GST-1435;
  //   seam=reviewExclude in head mode, observed through GIT_TRACE; no_claim=wall-clock time (the PR body has the timings)
  test('the consumer scan greps only consumer files, never the data under the patterns, and still finds full-path references', () => {
    const repo = census();
    const bulk: Record<string, string> = {};
    for (let k = 0; k < 200; k++) bulk[`receipts/bulk/${k}/result.json`] = JSON.stringify({ next: `receipts/bulk/${k + 1}/result.json`, peer: 'receipts/b/result.json' }) + '\n';
    commit(repo, bulk, 'bulk receipts');
    const head = repo.git('rev-parse', 'HEAD');
    const baseSha = repo.git('rev-parse', 'origin/main');
    const c = collectCommit(repo.work, baseSha, head);
    const trace = path.join(repo.root, 'git-trace.log');
    const prior = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    let x: ReturnType<typeof reviewExclude>;
    try { x = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged: new Set(), context: 'test' }); }
    finally { if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior; }
    expect(x.state).toBe('active');
    if (x.state !== 'active') return;
    expect(x.kept.filter(k => k.reason !== 'executable')).toEqual([{ path: 'receipts/b/result.json', reason: 'named-by-code' }, { path: 'receipts/d/fixture.json', reason: 'named-by-code' }]);
    expect(x.excluded.has('receipts/bulk/7/result.json')).toBe(true);
    const greps = fs.readFileSync(trace, 'utf8').split('\n').filter(l => /built-in: git( -c \S+)* grep /.test(l));
    expect(greps.length).toBeGreaterThan(0);
    expect(greps.filter(l => / -- /.test(l))).toEqual([]);
  }, 120_000);

  // Value: protects=the plan's consumer scan and binary read finish in a fixed number of git calls however many files the tree
  //   and the PR hold, so a results PR cannot push the plan past gstack-review-dispatch's 180 s limit; fails_when=the scan greps
  //   in pathspec chunks (one call per 24 KB of consumer names) or reads one blob per git call, so the count grows with the
  //   tree; why_new=GST-1442 (harness-evals #269: 363 greps over a 192k-file tree, 2 min 38 s on a Capy machine);
  //   seam=reviewExclude in head and live mode, git processes counted through GIT_TRACE; no_claim=wall-clock time
  test('the consumer scan and the binary read take the same git calls for 20 or 1,200 files', () => {
    const calls = (n: number, live: boolean) => {
      const repo = census();
      const files: Record<string, string> = {};
      for (let k = 0; k < n; k++) {
        files[`receipts/many/${k}/result.json`] = `{"k": ${k}}\n`;
        files[`lib/generated/a-consumer-module-with-a-long-enough-name-${k}.ts`] = `export const k${k} = ${k};\n`;
      }
      files['lib/generated/reads.ts'] = "export const p = 'receipts/many/3/result.json';\n";
      for (let k = 0; k < n; k++) write(repo.work, `receipts/shots/${k}.png`, `\x89PNG\0${k}`);
      commit(repo, files, 'many receipts');
      const baseSha = repo.git('rev-parse', 'origin/main');
      const head = repo.git('rev-parse', 'HEAD');
      const c = live ? collectLive(repo.work, 'origin/main') : collectCommit(repo.work, baseSha, head);
      const trace = path.join(repo.root, 'git-trace.log');
      const prior = process.env.GIT_TRACE;
      process.env.GIT_TRACE = trace;
      let x: ReturnType<typeof reviewExclude>;
      try { x = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, ...(live ? {} : { head }), perPath: c.perPath, added: c.added, classRoot: live ? repo.work : c.root ?? [], gateTagged: new Set(), context: 'test' }); }
      finally { if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior; }
      expect(x.state).toBe('active');
      if (x.state !== 'active') return -1;
      expect(x.kept).toContainEqual({ path: 'receipts/many/3/result.json', reason: 'named-by-code' });
      expect([`receipts/many/${n - 1}/result.json`, `receipts/shots/${n - 1}.png`].every(p => x.excluded.has(p))).toBe(true);
      return fs.readFileSync(trace, 'utf8').split('\n').filter(l => /trace: built-in: git /.test(l)).length;
    };
    for (const live of [false, true]) expect({ live, calls: calls(1200, live) }).toEqual({ live, calls: calls(20, live) });
  }, 240_000);

  // GST-1435 review (outside-voice#1): a consumer whose name is not valid UTF-8 comes back from ls-tree as U+FFFD, so its literal
  //   pathspec matches nothing; fails_when=the scan treats that as no match and excludes the data the file names instead of keeping
  //   every candidate; seam=reviewExclude in head mode
  test.skipIf(process.platform === 'win32' || process.platform === 'darwin')('a consumer whose name is not valid UTF-8 keeps the candidates, not excludes them', () => {
    const repo = census();
    commit(repo, { 'receipts/z/result.json': '{}\n' }, 'receipt');
    fs.writeFileSync(Buffer.concat([Buffer.from(path.join(repo.work, 'lib/reader-')), Buffer.from([0xff]), Buffer.from('.js')]), "read('receipts/z/result.json')\n");
    commit(repo, {}, 'reader with a non-UTF-8 name');
    const head = repo.git('rev-parse', 'HEAD');
    const baseSha = repo.git('rev-parse', 'origin/main');
    const c = collectCommit(repo.work, baseSha, head);
    const x = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged: new Set(), context: 'test' });
    expect(x.state).toBe('active');
    if (x.state !== 'active') return;
    expect(x.excluded.has('receipts/z/result.json')).toBe(false);
  }, 120_000);

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a live binary file whose bytes cannot be read is kept, not excluded', () => {
    const repo = census();
    const gz = path.join(repo.work, 'receipts/a/shot.png');
    fs.writeFileSync(gz, Buffer.from([0x89, 0x50, 0, 1]));
    commit(repo, {});
    fs.writeFileSync(gz, Buffer.from([0x89, 0x50, 0, 2]));
    fs.chmodSync(gz, 0o000);
    try {
      const c = collectLive(repo.work, 'origin/main');
      const x = reviewExclude({ root: repo.work, baseSha: repo.git('rev-parse', 'origin/main'), ref: 'origin/main', mergeBase: c.mergeBase!, perPath: [...c.perPath, { path: 'receipts/a/shot.png', lines: 0, binary: true }], added: c.added, classRoot: repo.work, gateTagged: new Set(), context: 'test' });
      expect(x.state).toBe('active');
      if (x.state !== 'active') return;
      expect(x.excluded.has('receipts/a/shot.png')).toBe(false);
      expect(x.kept).toContainEqual({ path: 'receipts/a/shot.png', reason: 'consumer-scan-unavailable' });
    } finally { fs.chmodSync(gz, 0o644); }
  }, 120_000);

  // Value: protects=the receipt (head blobs) and the plan (live files) agree on binary content past 256 MB of blobs; fails_when=
  //   one git cat-file --batch read stops at its buffer and later blobs fall through to kept code, so the digests differ and
  //   receipt write refuses on every rerun; why_new=/ship review of the GST-508 wave (Red Team, reproduced at 280 MB); seam=binaryContent
  test('head mode reads each blob\'s first 8,000 bytes, so blobs after 256 MB of others are still binary', () => {
    const repo = census();
    fs.mkdirSync(path.join(repo.work, 'receipts/big'), { recursive: true });
    const big = Buffer.alloc(270 * 1024 * 1024);
    fs.writeFileSync(path.join(repo.work, 'receipts/big/a.dat'), big);
    big[big.length - 1] = 1;
    fs.writeFileSync(path.join(repo.work, 'receipts/big/c.dat'), big);
    fs.writeFileSync(path.join(repo.work, 'receipts/big/b.dat'), GZ);
    commit(repo, {});
    const head = repo.git('rev-parse', 'HEAD');
    const baseSha = repo.git('rev-parse', 'origin/main');
    const c = collectCommit(repo.work, baseSha, head);
    const atHead = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged: new Set(), context: 'test' });
    const l = collectLive(repo.work, 'origin/main');
    const live = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: l.mergeBase!, perPath: l.perPath, added: l.added, classRoot: repo.work, gateTagged: new Set(), context: 'test' });
    expect(atHead.state === 'active' && [...atHead.excluded].filter(p => p.startsWith('receipts/big/')).sort()).toEqual(['receipts/big/a.dat', 'receipts/big/b.dat', 'receipts/big/c.dat']);
    expect(atHead.state === 'active' && live.state === 'active' && atHead.record.digest).toBe(live.state === 'active' ? live.record.digest : 'none');
  }, 180_000);
});

