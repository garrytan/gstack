/**
 * The five no-stop defaults (GSTA-258 K1, lib/no-stop.ts, bin/gstack-no-stop): each routine stop that qualifies is
 * recorded as {class, reason, evidence} and the run goes on; anything that does not qualify, and any stop outside
 * the five, still stops for the owner. The autoplan re-gate is covered in test/autoplan-carry.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { validateReceipt } from '../lib/ship-receipt';
import { lineDiff } from '../lib/autoplan-confirm';
import { checkNoStop, notEli5Only, notStampOnly, parseDiff, type NoStopRecord } from '../lib/no-stop';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-no-stop');
const ID = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-stop-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const diff = (file: string, was: string[], now: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,3 +1,3 @@', ' context', ...was.map(l => '-' + l), ...now.map(l => '+' + l), ' context', ''].join('\n');
const TIMEOUT = diff('test/worker.test.ts', ["  test('drains', async () => { await drain(); }, 5_000);"], ["  test('drains', async () => { await drain(); }, 30_000);"]);
const check = (cls: string, d?: string, prior: NoStopRecord[] = []) => checkNoStop({ cls, reason: 'r', evidence: 'run 41715705702', prior, diff: d, root: ROOT });

describe('lib/no-stop: what qualifies', () => {
  test('scoped-fix-check: a docs-only or timeout-only round-2 fix qualifies once; code, skill prose or a second one stops', () => {
    expect(check('scoped-fix-check', diff('docs/review-policy-notes.md', ['old wording'], ['new wording']))).toMatchObject({ ok: true, detail: expect.stringContaining('docs-only') });
    expect(check('scoped-fix-check', TIMEOUT)).toMatchObject({ ok: true, detail: expect.stringContaining('timeout-only') });
    expect(check('scoped-fix-check', diff('lib/worker.ts', ['return a;'], ['return b;']))).toMatchObject({ ok: false, reason: expect.stringContaining('neither docs-only') });
    expect(check('scoped-fix-check', diff('ship/SKILL.md.tmpl', ['old'], ['new']))).toMatchObject({ ok: false });
    expect(check('scoped-fix-check', TIMEOUT, [{ class: 'scoped-fix-check', reason: 'x', evidence: 'y' }])).toMatchObject({ ok: false, reason: expect.stringContaining('a second goes to the owner') });
  });

  test('test-timeout-fix: only a raised timeout in a test file qualifies', () => {
    expect(check('test-timeout-fix', TIMEOUT)).toMatchObject({ ok: true });
    expect(check('test-timeout-fix', diff('test/worker.test.ts', ["  test('drains', async () => { await drain(); }, 30_000);"], ["  test('drains', async () => { await drain(); }, 5_000);"]))).toMatchObject({ ok: false, reason: expect.stringContaining('does not raise') });
    expect(check('test-timeout-fix', diff('test/worker.test.ts', ['expect(n).toBe(3);'], ['expect(n).toBe(4);']))).toMatchObject({ ok: false, reason: expect.stringContaining('more than a timeout') });
    expect(check('test-timeout-fix', diff('lib/worker.ts', ['const timeoutMs = 5000;'], ['const timeoutMs = 9000;']))).toMatchObject({ ok: false, reason: expect.stringContaining('not a test file') });
    expect(check('test-timeout-fix', diff('test/worker.test.ts', [], ['  // a new line, timeout 30_000']))).toMatchObject({ ok: false });
  });

  test('review pass 1 holes: an assertion bound, a name that only contains "timeout", and a "-- " line inside a hunk are not timeout-only', () => {
    expect(check('test-timeout-fix', diff('test/perf.test.ts', ['  expect(elapsedMs).toBeLessThan(timeoutMs + 100);'], ['  expect(elapsedMs).toBeLessThan(timeoutMs + 5000);']))).toMatchObject({ ok: false });
    expect(check('scoped-fix-check', diff('lib/retry.ts', ['const MAX_ATTEMPTS_BEFORE_TIMEOUT = 3;'], ['const MAX_ATTEMPTS_BEFORE_TIMEOUT = 30;']))).toMatchObject({ ok: false });
    expect(check('test-timeout-fix', diff('test/x.test.ts', ['  setDefaultTimeout(5_000);'], ['  setDefaultTimeout(30_000);']))).toMatchObject({ ok: true });
    const hidden = 'diff --git a/test/x.test.ts b/test/x.test.ts\n--- a/test/x.test.ts\n+++ b/test/x.test.ts\n@@ -1,2 +1,1 @@\n--- guard\n-  }, 5000);\n+  }, 50000);\n';
    expect(check('test-timeout-fix', hidden)).toMatchObject({ ok: false });
  });

  test('pregate-flake-rerun: one rerun per branch; a second stops', () => {
    expect(check('pregate-flake-rerun')).toMatchObject({ ok: true });
    expect(check('pregate-flake-rerun', undefined, [{ class: 'pregate-flake-rerun', reason: 'x', evidence: 'y' }])).toMatchObject({ ok: false });
  });

  test('stamp-only-carry: a version-only VERSION or package.json move qualifies; a dependency or a product file stops', () => {
    const stamp = diff('package.json', ['  "version": "1.94.41.0",'], ['  "version": "1.94.42.0",']) + diff('VERSION', ['1.94.41.0'], ['1.94.42.0']);
    expect(check('stamp-only-carry', stamp)).toMatchObject({ ok: true, detail: 'version stamp only in package.json, VERSION' });
    expect(notStampOnly(parseDiff(diff('package.json', ['  "zod": "3.0.0",'], ['  "zod": "4.0.0",'])))).toContain('changes more than the version');
    expect(check('stamp-only-carry', diff('package.json', ['  "dev": "bun run a",'], ['  "dev": "bun run b",']))).toMatchObject({ ok: false, reason: expect.stringContaining('more than the version') });
    expect(check('stamp-only-carry', stamp + diff('lib/worker.ts', ['a'], ['b']))).toMatchObject({ ok: false, reason: 'lib/worker.ts is not a stamp file' });
  });

  test('anything outside the five, a missing reason or evidence, or a hand-recorded re-gate still stops', () => {
    expect(check('merge-anyway')).toMatchObject({ ok: false, reason: expect.stringContaining('not one of the five') });
    expect(checkNoStop({ cls: 'pregate-flake-rerun', reason: ' ', evidence: 'run 1', prior: [] })).toMatchObject({ ok: false });
    expect(check('autoplan-regate')).toMatchObject({ ok: false, reason: expect.stringContaining('gstack-autoplan decides') });
  });

  test('notEli5Only: only added lines inside ## ELI5 that name no number, spend, cap, arm, model or verdict carry', () => {
    const PLAN = '# Plan\n\nRetry the webhook worker, cap 30 s.\n\n## ELI5\n\nRetries wait longer each time.\n';
    const edit = (after: string) => notEli5Only(lineDiff(PLAN, after));
    expect(edit(PLAN + 'They stop hammering the service.\n')).toBeNull();
    expect(edit('# Plan\n\nRetry the webhook worker, cap 30 s.\n\n## ELI5\n\nRetries wait longer each time.\nNothing else changes.\n\n## Notes\n')).toContain('adds a heading');
    expect(notEli5Only(lineDiff('# Plan\n\nDo it.\n', '# Plan\n\nDo it.\n\n## ELI5\n\nIt waits longer.\n'))).toBeNull();
    expect(edit(PLAN.replace('Retry the webhook worker', 'Retry the webhook worker and the queue'))).toContain('removes or rewrites');
    expect(edit(PLAN.replace('cap 30 s.\n', 'cap 30 s.\nAlso delete the users table.\n'))).toContain('outside ## ELI5');
    expect(edit(PLAN + 'It runs (30 times) per case.\n')).toContain('names a number');
    expect(edit(PLAN + 'Run it on **Opus** instead.\n')).toContain('names a number');
    expect(edit(PLAN + 'The budget grows.\n')).toContain('names a number');
    expect(edit(PLAN)).toBe('the edit adds no ELI5 line');
  });

  test('review pass 2 holes: a retry count, or a brace that closes any multi-line call, is not a timeout', () => {
    expect(check('test-timeout-fix', diff('test/a.test.ts', ['  retry({ fn }, 3);'], ['  retry({ fn }, 10);']))).toMatchObject({ ok: false });
    expect(check('test-timeout-fix', diff('test/a.test.ts', ['  }, 3);'], ['  }, 30);']))).toMatchObject({ ok: false });
  });
});

describe('gstack-no-stop record: the ledger, the grant and the receipt', () => {
  const work = path.join(tmp, 'repo');
  const state = path.join(tmp, 'state');
  const env = { ...process.env, ...ID, GSTACK_STATE_ROOT: state, GSTACK_APPROVALS_DIR: path.join(tmp, 'approvals') };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', timeout: 30_000, env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const run = (...args: string[]) => spawnSync('bun', [...bunIsolationArgs(), BIN, ...args], { cwd: work, encoding: 'utf8', timeout: 60_000, env });
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  git('init', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(work, 'docs', 'guide.md'), 'old wording\n');
  fs.writeFileSync(path.join(work, 'lib.ts'), 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const slug = Object.fromEntries(spawnSync(path.join(ROOT, 'bin', 'gstack-slug'), [], { cwd: work, encoding: 'utf8', timeout: 30_000, env }).stdout.trim().split('\n').map(l => l.split('=') as [string, string]));
  const reviewLog = path.join(state, 'projects', slug.SLUG!, `${slug.BRANCH}-reviews.jsonl`);
  fs.mkdirSync(path.dirname(reviewLog), { recursive: true });
  fs.writeFileSync(reviewLog, JSON.stringify({ skill: 'review', commit_full: base }) + '\n');

  test('a docs-only round-2 fix records the class, prints the grant, and the ledger is a valid receipt no_stop', () => {
    fs.writeFileSync(path.join(work, 'docs', 'guide.md'), 'new wording\n');
    git('commit', '-qam', 'docs fix');
    const narrow = run('record', '--class', 'scoped-fix-check', '--range-base', 'HEAD~0', '--reason', 'r', '--evidence', 'e');
    expect(narrow.status).toBe(3);
    expect(narrow.stderr).toContain('is not the commit the last review pass read');
    const r = run('record', '--class', 'scoped-fix-check', '--range-base', base, '--reason', 'round-2 fix reworded docs/guide.md', '--evidence', `commit ${git('rev-parse', 'HEAD').slice(0, 12)}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^NO_STOP: scoped-fix-check recorded \(docs-only fix in docs\/guide\.md\)$/m);
    expect(r.stdout).toMatch(/^GRANT: \S+$/m);
    expect(r.stdout).toContain(`--range-base ${base}`);
    const file = r.stdout.match(/^NO_STOP_FILE: (.+)$/m)![1]!;
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rows).toEqual([{ class: 'scoped-fix-check', reason: 'round-2 fix reworded docs/guide.md', evidence: expect.stringMatching(/^commit /) }]);
    const approvals = spawnSync('bun', [...bunIsolationArgs(), path.join(ROOT, 'bin', 'gstack-approvals'), 'list', '--json'], { cwd: work, encoding: 'utf8', timeout: 60_000, env });
    const grant = r.stdout.match(/^GRANT: (\S+)$/m)![1];
    expect(JSON.parse(approvals.stdout).rows ?? JSON.parse(approvals.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id: grant, outcome: 'approved', by: 'gstack no-stop default (K1)', scope: `review_loop_grant ${git('rev-parse', 'HEAD')}` })]));
    const receipt = { schema_version: 1, pr: 1, head: 'e'.repeat(40), version: '1.0.0.0', base: 'main', gate: {}, no_stop: rows };
    expect(validateReceipt(receipt as any).filter(e => /no_stop/.test(String(e)))).toEqual([]);
  });

  test('a second scoped fix-check and a code fix both stop for the owner (exit 3) and leave the ledger alone', () => {
    const before = run('list', '--json');
    const second = run('record', '--class', 'scoped-fix-check', '--range-base', base, '--reason', 'again', '--evidence', 'commit x');
    expect(second.status).toBe(3);
    expect(second.stderr).toMatch(/^NO_STOP: refused scoped-fix-check \(one scoped-fix-check per branch is recorded already; a second goes to the owner\); stop for the owner$/m);
    fs.writeFileSync(path.join(work, 'lib.ts'), 'export const a = 2;\n');
    git('commit', '-qam', 'code fix');
    const code = run('record', '--class', 'test-timeout-fix', '--range-base', 'HEAD~1', '--reason', 'r', '--evidence', 'e');
    expect(code.status).toBe(3);
    expect(code.stderr).toContain('NO_STOP: refused test-timeout-fix (not a test file: lib.ts)');
    expect(run('list', '--json').stdout).toBe(before.stdout);
  });

  test('a checkout with an empty ledger still sees the branch\'s K1 grant in the approval record and stops', () => {
    const file = JSON.parse(run('list', '--json').stdout).file as string;
    const saved = fs.readFileSync(file, 'utf8');
    fs.rmSync(file);
    const r = run('record', '--class', 'scoped-fix-check', '--range-base', base, '--reason', 'again', '--evidence', 'commit x');
    fs.writeFileSync(file, saved);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('the approval record already holds this branch\'s K1 grant');
  });

  test('a class outside the five stops, and the range-based classes need --range-base', () => {
    expect(run('record', '--class', 'merge-anyway', '--reason', 'r', '--evidence', 'e').status).toBe(3);
    expect(run('record', '--class', 'stamp-only-carry', '--reason', 'r', '--evidence', 'e').status).toBe(2);
  });
});

describe('gstack-no-stop record --class stamp-only-carry --base, and import', () => {
  const work = path.join(tmp, 'stamp');
  const env = { ...process.env, ...ID, GSTACK_STATE_ROOT: path.join(tmp, 'state2'), GSTACK_APPROVALS_DIR: path.join(tmp, 'approvals2') };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', timeout: 30_000, env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(work, rel), text);
  const run = (...args: string[]) => spawnSync('bun', [...bunIsolationArgs(), BIN, ...args], { cwd: work, encoding: 'utf8', timeout: 60_000, env });
  fs.mkdirSync(work, { recursive: true });
  git('init', '-q', '-b', 'main');
  write('VERSION', '1.0.0.0\n'); write('app.ts', 'export const a = 1;\n'); write('other.ts', 'export const b = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feat');
  write('app.ts', 'export const a = 2;\n'); write('VERSION', '1.0.1.0\n'); git('commit', '-qam', 'feature');
  const receiptHead = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  write('other.ts', 'export const b = 2;\n'); write('VERSION', '1.0.2.0\n'); git('commit', '-qam', 'main moves');
  git('checkout', '-q', 'feat');
  spawnSync('git', ['merge', '-q', 'main', '-m', 'merge main'], { cwd: work, encoding: 'utf8', timeout: 30_000, env });
  write('VERSION', '1.0.3.0\n'); git('add', '-A'); git('commit', '-qm', 'merge main + stamp');

  test('a base merge plus a version stamp qualifies against the receipt head merged into the base', () => {
    const r = run('record', '--class', 'stamp-only-carry', '--range-base', receiptHead, '--base', 'main', '--reason', 'restamp after the base moved', '--evidence', `commit ${git('rev-parse', 'HEAD').slice(0, 12)}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^NO_STOP: stamp-only-carry recorded \(version stamp only in VERSION\)$/m);
    const plain = run('record', '--class', 'stamp-only-carry', '--range-base', receiptHead, '--reason', 'r', '--evidence', 'e');
    expect(plain.status).toBe(3);
    expect(plain.stderr).toContain('other.ts is not a stamp file');
  });

  test('a product edit inside the stamp commit still stops', () => {
    write('app.ts', 'export const a = 3;\n'); write('VERSION', '1.0.4.0\n'); git('commit', '-qam', 'stamp plus a sneaky edit');
    const r = run('record', '--class', 'stamp-only-carry', '--range-base', receiptHead, '--base', 'main', '--reason', 'r', '--evidence', 'e');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('app.ts is not a stamp file');
  });

  test('a rename into changelog.d with an edit is a deletion plus an add, so it still stops', () => {
    write('notes.md', 'one\ntwo\nthree\nfour\nfive\nsix\n'); git('add', '-A'); git('commit', '-qm', 'notes');
    const from = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(work, 'changelog.d'), { recursive: true });
    git('mv', 'notes.md', 'changelog.d/notes.md'); write('changelog.d/notes.md', 'one\ntwo\nthree\nfour\nfive\nseven\n'); git('add', '-A'); git('commit', '-qm', 'move');
    const r = run('record', '--class', 'stamp-only-carry', '--range-base', from, '--reason', 'r', '--evidence', 'e');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('notes.md is not a stamp file');
  });

  test('import adds an autoplan run\'s re-gate records once and skips every other class', () => {
    const src = path.join(tmp, 'run-no-stop.json');
    fs.writeFileSync(src, JSON.stringify([{ class: 'autoplan-regate', reason: 'plan edit, no spend', evidence: 'autoplan:run-1@gate_rev=2' }, { class: 'merge-anyway', reason: 'x', evidence: 'y' }, { class: 'stamp-only-carry', reason: 'x', evidence: 'y' }, { class: 'autoplan-regate', reason: 'x', evidence: 'hand-written' }]));
    const first = run('import', '--from', src).stdout;
    expect(first).toMatch(/^NO_STOP: imported 1 record\(s\)/m);
    expect(first).toMatch(/^NO_STOP: skipped 3 record\(s\): import takes only autoplan-regate records/m);
    expect(run('import', '--from', src).stdout).toMatch(/^NO_STOP: imported 0 record\(s\)/m);
    expect(JSON.parse(run('list', '--json').stdout).records.map((r: NoStopRecord) => r.class)).toEqual(['stamp-only-carry', 'autoplan-regate']);
  });
});

describe('the no-stop defaults in the /ship and /autoplan sources', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const ship = read('ship/sections/tests.md.tmpl');
  const help = spawnSync('bun', [...bunIsolationArgs(), BIN, '--help'], { encoding: 'utf8', timeout: 60_000 }).stdout;
  test.each(['scoped-fix-check', 'test-timeout-fix', 'pregate-flake-rerun', 'stamp-only-carry', 'autoplan-regate'])('the bin help and the policy say what to do on %s', cls => {
    expect(help).toMatch(new RegExp('^      ' + cls + ' +\\S', 'm'));
    expect(read('docs/review-policy.md')).toContain('| `' + cls + '` |');
  });
  test('a refused case and any other stop still stop; the receipt write carries the ledger', () => {
    expect(ship).toContain('three other routine stops go through `gstack-no-stop record` (`--help`); `recorded` goes on,\n`refused` stops.');
    expect(help).toContain('NO_STOP: refused (exit 3): the stop stands. Anything else still stops.');
    expect(read('ship/sections/pr-body.md.tmpl')).toContain('${NS:+--no-stop "@$NS"}');
    expect(read('ship/DRIVER.md.tmpl')).toContain('end the run, except `gstack-no-stop`');
    expect(read('autoplan/DRIVER.md.tmpl')).toContain("K1's `autoplan-regate` no-stop");
  });
});
