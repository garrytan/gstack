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
import { bindShippedReceipt } from '../lib/ship-receipt-depth';
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
    for (const f of EXCLUDED) expect(outside).not.toContain(`diff --git a/${f}`);
    expect(outside).toContain('diff --git a/receipts/b/result.json');
    for (const b of briefs) expect(b).toContain(`(selection ${m.review_exclude.digest})`);
  }, 180_000);

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
    expect(c.targeted.classes).toEqual(['money', 'secret']);
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
    expect(writeReceipt(repo, body, ['--review-exclude', digest!]).status).toBe(EXIT.ok);
    expect(receiptIn(body).review_exclude).toMatchObject({ digest, excluded: EXCLUDED.length, kept: KEPT.length });

    onBase(repo, { 'docs/other.md': '# other\n' });
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(carried.status).toBe(EXIT.ok);
    expect(receiptIn(body).review_exclude!.digest).toBe(digest!);

    onBase(repo, { '.gstack/ship-policy.json': policyText(['receipts/**', 'results/**']) });
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
});

